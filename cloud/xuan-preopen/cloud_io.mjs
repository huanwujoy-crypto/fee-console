// Fixed private destinations. No filesystem credential, bucket or secret flags.
import crypto from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {ibError, inIbPhase, httpCategory, networkCategory} from './ib_diagnostics.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
export const PROJECT = 'family-portfolio-gateway';
export const BUCKET = `${PROJECT}-xuan-preopen-private`;
const IB_SECRET = `projects/${PROJECT}/secrets/xuan-preopen-ib-mcp`;
const READ_SECRET = `projects/${PROJECT}/secrets/family-portfolio-gateway-key`;
// Existing normal cash-sync/weekly token, pinned to its existing version.
const FLEX_SECRET = `projects/${PROJECT}/secrets/ib-flex-cash-token`;
export const IB_CREDENTIAL_LOCK_KEY='report-check/ib-mcp-credential/lease.json';
const LOCK_META=`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(IB_CREDENTIAL_LOCK_KEY)}`;
const LOCK_UPLOAD=`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`;
const lockError=code=>ibError(code,{phase:'credential_load',category:'forbidden'});
function validLease(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype
    ||Object.keys(value).sort().join('|')!=='expiresAt|lastSavedVersion|owner|phase|schema'
    ||value.schema!==1||!/^[a-f0-9-]{36}$/.test(value.owner||'')
    ||!['idle','loading','refreshing','saving'].includes(value.phase)
    ||(value.phase==='idle'?value.expiresAt!==null:!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0)
    ||!(value.lastSavedVersion===null||typeof value.lastSavedVersion==='string'&&/^[1-9]\d{0,29}$/.test(value.lastSavedVersion)))
    throw lockError('IB_CREDENTIAL_LEASE_INVALID');
  return value;
}
// The existing preview allowlist can admit only this single mutable object.
// No arbitrary bucket/key, delete, Secret or financial route is introduced.
export function isIbCredentialLockRequest(url,options={}){
  try{const u=new URL(String(url)),method=options.method??'GET';if(u.username||u.password||u.hash)return false;
    if(u.origin+u.pathname===LOCK_META&&method==='GET')return u.search===''||
      [...u.searchParams.keys()].sort().join('|')==='alt|generation'&&u.searchParams.get('alt')==='media'&&/^[1-9]\d*$/.test(u.searchParams.get('generation')||'');
    if(u.origin+u.pathname!==LOCK_UPLOAD||method!=='POST'||[...u.searchParams.keys()].sort().join('|')!=='ifGenerationMatch|name|uploadType'
      ||u.searchParams.get('name')!==IB_CREDENTIAL_LOCK_KEY||u.searchParams.get('uploadType')!=='media'
      ||!/^(?:0|[1-9]\d*)$/.test(u.searchParams.get('ifGenerationMatch')||''))return false;
    const bytes=Buffer.isBuffer(options.body)?options.body:typeof options.body==='string'?Buffer.from(options.body):null;
    if(!bytes||bytes.length>4096)return false;validLease(uniqueCloudJson(bytes.toString('utf8'),4096));return true;
  }catch{return false;}
}

// One fixed CAS record serializes credential load -> optional refresh -> saved
// rotation. Expired *loading* holders may be replaced. Once refresh is marked,
// expiry cannot authorize another refresh: an unknown outcome needs recovery.
export function createIbCredentialLease({read,cas,now=Date.now,owner=()=>crypto.randomUUID()}={}){
  let running=false;
  const checked=async()=>{const row=await read();if(!row||!/^(?:0|[1-9]\d*)$/.test(String(row.generation)))throw lockError('IB_CREDENTIAL_LEASE_INVALID');
    if(row.value===null){if(String(row.generation)!=='0')throw lockError('IB_CREDENTIAL_LEASE_INVALID');}
    else validLease(row.value);return {value:row.value,generation:String(row.generation)};};
  const write=async(generation,value)=>{
    try{const next=String(await cas(generation,value));if(!/^[1-9]\d*$/.test(next)||next===generation)throw Error('unconfirmed');return next;}
    catch(error){if(error?.message==='CLOUD_HTTP_412')throw lockError('IB_CREDENTIAL_LEASE_CONFLICT');
      // Read back once; never blindly repeat an uncertain CAS write.
      try{const observed=await checked();if(observed.generation!==generation&&JSON.stringify(observed.value)===JSON.stringify(value))return observed.generation;}catch{}
      throw lockError('IB_CREDENTIAL_LEASE_OUTCOME_UNKNOWN');}
  };
  return {async run(callback){
    if(running)throw lockError('IB_CREDENTIAL_LEASE_BUSY');running=true;
    let value,generation,loadedVersion=null,savedVersion=null;
    const owns=async(expiry=false)=>{const current=await checked();
      if(current.generation!==generation||current.value?.owner!==value.owner||current.value.phase!==value.phase)throw lockError('IB_CREDENTIAL_LEASE_LOST');
      if(expiry&&now()>=value.expiresAt)throw lockError('IB_CREDENTIAL_LEASE_EXPIRED');return current;};
    const transition=async(phase,expiry)=>{await owns(expiry);const next={...value,phase};generation=await write(generation,next);value=next;};
    const release=async()=>{await owns();const next={...value,phase:'idle',expiresAt:null,lastSavedVersion:savedVersion??value.lastSavedVersion};
      generation=await write(generation,next);value=next;};
    try{
      const previous=await checked();generation=previous.generation;
      if(previous.value&&previous.value.phase!=='idle'){
        if(previous.value.phase!=='loading')throw lockError('IB_CREDENTIAL_RECOVERY_REQUIRED');
        if(now()<previous.value.expiresAt)throw lockError('IB_CREDENTIAL_LEASE_BUSY');
      }
      value={schema:1,owner:owner(),phase:'loading',expiresAt:now()+120000,lastSavedVersion:previous.value?.lastSavedVersion??null};validLease(value);
      generation=await write(generation,value);
      const lease={
        async assertLoading(version=null){await owns(true);if(value.phase!=='loading')throw lockError('IB_CREDENTIAL_LEASE_PHASE_INVALID');
          if(version!==null&&value.lastSavedVersion!==null&&BigInt(version)<BigInt(value.lastSavedVersion))throw lockError('IB_CREDENTIAL_BINDING_STALE');},
        loaded(version){if(!/^[1-9]\d*$/.test(version)||value.lastSavedVersion!==null&&BigInt(version)<BigInt(value.lastSavedVersion))throw lockError('IB_CREDENTIAL_BINDING_STALE');loadedVersion=version;},
        async beforeRefresh(){if(value.phase!=='loading'||loadedVersion===null)throw lockError('IB_CREDENTIAL_LEASE_PHASE_INVALID');await transition('refreshing',true);},
        async beforeSave(){if(value.phase!=='refreshing')throw lockError('IB_CREDENTIAL_LEASE_PHASE_INVALID');await transition('saving',false);},
        saved(name){const version=String(name).split('/').at(-1);if(value.phase!=='saving'||!loadedVersion||!/^[1-9]\d*$/.test(version)||BigInt(version)<=BigInt(loadedVersion))throw lockError('IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');savedVersion=version;}
      };
      let result;
      try{result=await callback(lease);if(value.phase==='loading')await owns(true);
        if(value.phase!=='loading'&&savedVersion===null)throw lockError('IB_CREDENTIAL_ROTATION_OUTCOME_UNKNOWN');}
      catch(error){
        if(value.phase==='loading'||savedVersion!==null)await release();
        // Critical phase deliberately remains durable, including after expiry.
        throw error;
      }
      await release();return result;
    }finally{running=false;}
  }};
}

// Finite origin metadata only. Never inspect messages, stacks, URLs or bodies.
const ORIGIN_TYPES=new Set(['Error','TypeError','RangeError','SyntaxError','URIError','EvalError','AggregateError','AbortError','TimeoutError']);
const ORIGIN_CODES=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ECONNABORTED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE','ENOENT','EACCES','EPERM','EBADF','EINVAL','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ABORT_ERR']);
const ownData=(value,key)=>{try{if(!value||!['object','function'].includes(typeof value)||nodeTypes.isProxy(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}};
const finiteCode=value=>typeof value==='string'&&ORIGIN_CODES.has(value)?value:null;
const domName=Object.getOwnPropertyDescriptor(DOMException.prototype,'name').get;
const responseStatus=Object.getOwnPropertyDescriptor(Response.prototype,'status').get;
export function safeErrorOrigin(error,httpStatus=null){
  let type=null,status=typeof httpStatus==='number'?httpStatus:ownData(httpStatus,'status');
  if(error&&['object','function'].includes(typeof error)&&!nodeTypes.isProxy(error)){
    const name=ownData(error,'name');
    if(typeof name==='string'&&ORIGIN_TYPES.has(name))type=name;
    if(type===null)try{
      const prototype=Object.getPrototypeOf(error);
      for(const [ctor,label] of [[TypeError,'TypeError'],[RangeError,'RangeError'],[SyntaxError,'SyntaxError'],[URIError,'URIError'],[EvalError,'EvalError'],[AggregateError,'AggregateError'],[Error,'Error']])if(prototype===ctor.prototype){type=label;break;}
      if(type===null&&prototype===DOMException.prototype){const nativeName=domName.call(error);if(ORIGIN_TYPES.has(nativeName))type=nativeName;}
      if(type===null&&nodeTypes.isNativeError(error))type='Error';
    }catch{}
  }
  if(status===undefined&&httpStatus&&!nodeTypes.isProxy(httpStatus))try{status=responseStatus.call(httpStatus);}catch{}
  return Object.freeze({type,code:finiteCode(ownData(error,'code')),causeCode:finiteCode(ownData(ownData(error,'cause'),'code')),httpStatus:Number.isInteger(status)&&status>=100&&status<=599?status:null});
}

// These diagnostics are a finite failure projection, never response content,
// URLs, identifiers or arbitrary error messages. Malformed records are dropped.
export const OWNER_READ_REQUEST_CLASSES=Object.freeze(['github-main','github-association','github-call-ledger','github-public-meta','github-public-html',
  'github-preview-registration','github-preview-replacement','github-registered-canary','github-compare','other']);
export const OWNER_READ_STAGES=Object.freeze(['fetch','http','body']);
export const OWNER_FAILURE_VALIDATOR_PHASES=Object.freeze(['candidate-admission','historical-authenticity']);
export const OWNER_FAILURE_VALIDATOR_POINTS=Object.freeze(['entry','phase-clock','input-copy','metadata','context-first','display','context-second','final-check','proof']);
const CLOUD_BODY_CODES=new Set(['CLOUD_EMPTY_RESPONSE','CLOUD_RESPONSE_TOO_LARGE','CLOUD_INVALID_UTF8']);
const exactData=(value,keys)=>{
  try{
    if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return null;
    const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
    if(names.length!==keys.length||names.some(key=>!keys.includes(key)||!Object.hasOwn(descriptors[key],'value')))return null;
    return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
  }catch{return null;}
};
const nullableEnum=(value,allowed)=>value===null||allowed.includes(value);
const nullableCount=value=>value===null||Number.isSafeInteger(value)&&value>=0;
const publishReadDiagnostics=(output,value)=>{
  try{
    if(output&&typeof output==='object'&&!nodeTypes.isProxy(output)&&Object.getPrototypeOf(output)===Object.prototype)
      Object.defineProperty(output,'value',{value,writable:true,enumerable:true,configurable:true});
  }catch{}
};
const finiteOrigin=value=>{
  const data=exactData(value,['type','code','causeCode','httpStatus']);
  if(!data||!nullableEnum(data.type,[...ORIGIN_TYPES])||!nullableEnum(data.code,[...ORIGIN_CODES])||!nullableEnum(data.causeCode,[...ORIGIN_CODES])
    ||data.httpStatus!==null&&(!Number.isInteger(data.httpStatus)||data.httpStatus<100||data.httpStatus>599))return null;
  return Object.freeze(data);
};
export function ownerReadRequestClass(url){
  if(typeof url!=='string')return 'other';
  const api='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
  if(url===api+'commits/main')return 'github-main';
  if(new RegExp('^'+api.replaceAll('.','\\.')+'compare/[a-f0-9]{40}\\.\\.\\.[a-f0-9]{40}$').test(url))return 'github-compare';
  const raw='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/';
  if(!url.startsWith(raw)||!/^[a-f0-9]{40}\//.test(url.slice(raw.length)))return 'other';
  return new Map([
    ['claude/xuan-ib-account-association-v1.json','github-association'],['claude/xuan-ib-etf-pending-calls-v1.json','github-call-ledger'],
    ['xuan-ib/latest.meta.json','github-public-meta'],['xuan-ib/latest.html','github-public-html'],
    ['security/xuan-owner-accepted-preview.json','github-preview-registration'],['security/xuan-owner-preview-replacement.json','github-preview-replacement'],
    ['security/xuan-owner-registered-canary.json','github-registered-canary'],
  ]).get(url.slice(raw.length+41))??'other';
}
export function safeOwnerReadDiagnostics(value){
  const data=exactData(value,['schema','requestClass','readStage','httpStatus','observedBodyBytes','bodyLimitBytes','elapsedMs','timeoutMs','origin']);
  if(!data||data.schema!=='xuan.owner-read-diagnostics.v1'||!OWNER_READ_REQUEST_CLASSES.includes(data.requestClass)||!OWNER_READ_STAGES.includes(data.readStage)
    ||data.httpStatus!==null&&(!Number.isInteger(data.httpStatus)||data.httpStatus<100||data.httpStatus>599)
    ||!['observedBodyBytes','bodyLimitBytes','elapsedMs'].every(key=>nullableCount(data[key]))||data.elapsedMs!==null&&data.elapsedMs>86400000||![null,15000,30000].includes(data.timeoutMs))return null;
  const origin=finiteOrigin(data.origin);return origin?Object.freeze({...data,origin}):null;
}
export function attachOwnerReadDiagnostics(error,facts={}){
  try{
    if(!error||!['object','function'].includes(typeof error)||nodeTypes.isProxy(error))return error;
    const previous=safeOwnerReadDiagnostics(ownData(error,'ownerReadDiagnostics'));
    const data={schema:'xuan.owner-read-diagnostics.v1',requestClass:'other',readStage:'body',httpStatus:null,observedBodyBytes:null,bodyLimitBytes:null,elapsedMs:null,timeoutMs:null,
      origin:safeErrorOrigin(error),...previous};
    for(const key of Object.keys(data))if(key!=='schema'&&ownData(facts,key)!==undefined)data[key]=ownData(facts,key);
    const safe=safeOwnerReadDiagnostics(data);
    if(safe)Object.defineProperty(error,'ownerReadDiagnostics',{value:safe,enumerable:false,configurable:true});
  }catch{}
  return error;
}


export const OWNER_FAILURE_ORIGINAL_CODES=Object.freeze([
  'CLOUD_EMPTY_RESPONSE','CLOUD_INVALID_UTF8','CLOUD_RESPONSE_TOO_LARGE','CONFIG_UNAVAILABLE','DEADLINE',
  'FINANCIAL_STATE','HASH_MISMATCH','IMMUTABLE_BINDING','INVALID_BYTES','INVALID_DATE',
  'INVALID_SHAPE','INVALID_TIME','INVALID_VERIFICATION_PHASE','LATEST_BYTES_MISMATCH','LATEST_INVALID',
  'LATEST_UNKNOWN','OWNER_DELIVERY_BUNDLE_REQUIRED','OWNER_DELIVERY_COLLECTED_BUNDLE_CHANGED','OWNER_DELIVERY_COLLECTED_BYTES_REQUIRED','OWNER_DELIVERY_CONTEXT_HTTP',
  'OWNER_DELIVERY_DAILY_BINDING','OWNER_DELIVERY_EXISTING_IDENTITY_REQUIRED','OWNER_DELIVERY_EXPLICIT_EXECUTION_REQUIRED','OWNER_DELIVERY_HISTORICAL_ANCESTRY','OWNER_DELIVERY_HISTORICAL_CONTEXT',
  'OWNER_DELIVERY_HISTORICAL_PUBLIC_BINDING','OWNER_DELIVERY_PREVIEW_ACCESS_CAPABILITY_REQUIRED','OWNER_DELIVERY_PREVIEW_ANCESTRY','OWNER_DELIVERY_PREVIEW_CONTEXT','OWNER_DELIVERY_PREVIEW_CURRENT_CONTEXT',
  'OWNER_DELIVERY_PREVIEW_REGISTRATION_CHANGED','OWNER_DELIVERY_PREVIEW_REGISTRATION_JSON','OWNER_DELIVERY_PREVIEW_REPLACEMENT_ACCESS_REQUIRED','OWNER_DELIVERY_PREVIEW_REPLACEMENT_BYTES','OWNER_DELIVERY_PREVIEW_REPLACEMENT_CHANGED',
  'OWNER_DELIVERY_PREVIEW_REPLACEMENT_CURRENT_CONTEXT','OWNER_DELIVERY_PREVIEW_REPLACEMENT_METADATA','OWNER_DELIVERY_PREVIEW_REPLACEMENT_REGISTRATION','OWNER_DELIVERY_PROTECTED_CHECKOUT_REQUIRED','OWNER_DELIVERY_PROTECTED_SOURCE_BYTES_REQUIRED',
  'OWNER_DELIVERY_RECEIPT_JSON','OWNER_DELIVERY_TRANSPORT_ORIGIN','OWNER_DELIVERY_TRANSPORT_REQUIRED','OWNER_PREVIEW_ACCESS_CAPABILITY_RESULT','OWNER_PREVIEW_BYTES',
  'OWNER_PREVIEW_CANDIDATE','OWNER_PREVIEW_CANONICAL_HTML','OWNER_PREVIEW_CAPABILITIES_REQUIRED','OWNER_PREVIEW_CLOCK','OWNER_PREVIEW_CLOCK_CHANGED',
  'OWNER_PREVIEW_DEADLINE','OWNER_PREVIEW_DISPLAY_HASH','OWNER_PREVIEW_JSON','OWNER_PREVIEW_LOCAL_ARTIFACT_HASH','OWNER_PREVIEW_LOCAL_MANIFEST_BINDING',
  'OWNER_PREVIEW_LOCAL_MANIFEST_SCOPE','OWNER_PREVIEW_LOCAL_MANIFEST_TIME','OWNER_PREVIEW_LOCAL_MODEL_BINDING','OWNER_PREVIEW_METADATA_BINDING','OWNER_PREVIEW_MODEL_BINDING',
  'OWNER_PREVIEW_MODEL_MARKER','OWNER_PREVIEW_PHASE_OR_CLOCK','OWNER_PREVIEW_PROTECTED_VERIFIER_REJECTED','OWNER_PREVIEW_REGISTRATION_BINDING','OWNER_PREVIEW_REGISTRATION_CHANGED',
  'OWNER_PREVIEW_REGISTRATION_DATE','OWNER_PREVIEW_REGISTRATION_FINANCIAL_STATE','OWNER_PREVIEW_REGISTRATION_HASH','OWNER_PREVIEW_REGISTRATION_SCOPE','OWNER_PREVIEW_REGISTRATION_TIME',
  'OWNER_PREVIEW_REJECTED','OWNER_PREVIEW_REPLACEMENT_BINDING','OWNER_PREVIEW_REPLACEMENT_CHANGED','OWNER_PREVIEW_REPLACEMENT_CONTEXT','OWNER_PREVIEW_REPLACEMENT_OLD_BINDING',
  'OWNER_PREVIEW_REPLACEMENT_OLD_REQUIRED','OWNER_PREVIEW_REPLACEMENT_PROOF','OWNER_PREVIEW_REPLACEMENT_REGISTRATION','OWNER_PREVIEW_REPLACEMENT_SOURCE_CHANGED','OWNER_PREVIEW_REPLACEMENT_UNCHANGED',
  'OWNER_PREVIEW_STATIC_CARDS','OWNER_PREVIEW_STATIC_DISPLAY','OWNER_PREVIEW_STATIC_ORDER_SHAPE','OWNER_PREVIEW_TARGET_UNKNOWN','OWNER_PREVIEW_TRUSTED_REGISTRATION_BYTES',
  'OWNER_PREVIEW_TRUSTED_REGISTRATION_REQUIRED','OWNER_PREVIEW_UTF8','PREVIEW_FINANCIAL_STATE','PREVIEW_REGISTRATION_INVALID','PREVIEW_SCOPE_MISMATCH',
  'PREVIEW_TIME_ORDER','PROTECTED_GATES_REJECTED','PROTECTED_GATES_UNAVAILABLE','PROTECTED_PREVIEW_GATES_REJECTED','PROTECTED_PREVIEW_GATES_UNAVAILABLE',
  'REPORT_SOURCE_HTTP','REPORT_SOURCE_JSON_INVALID','REPORT_SOURCE_NETWORK_FAILED','SAME_SOURCE_CONFLICT','SCOPE_MISMATCH',
  'SIZE_LIMIT','SOURCE_IDENTITY_CHANGED','STALE_CANDIDATE','STATIC_RENDERER_REJECTED','STATIC_RENDERER_UNAVAILABLE',
  'TIME_ORDER',
]);
export function safeOwnerFailureEvidence(value){
  const data=exactData(value,['schema','validatorPhase','validatorPoint','originalCode','origin','read']);
  if(!data||data.schema!=='xuan.owner-failure-evidence.v1'||!nullableEnum(data.validatorPhase,OWNER_FAILURE_VALIDATOR_PHASES)
    ||!nullableEnum(data.validatorPoint,OWNER_FAILURE_VALIDATOR_POINTS)||!nullableEnum(data.originalCode,OWNER_FAILURE_ORIGINAL_CODES))return null;
  const origin=finiteOrigin(data.origin),read=data.read===null?null:safeOwnerReadDiagnostics(data.read);
  return origin&&(data.read===null||read)?Object.freeze({...data,origin,read}):null;
}
export function createOwnerFailureEvidence(error,{validatorPhase=null,validatorPoint=null}={}){
  const code=ownData(error,'safeCode'),message=ownData(error,'message');
  const originalCode=OWNER_FAILURE_ORIGINAL_CODES.includes(code)?code:CLOUD_BODY_CODES.has(message)?message:null;
  return safeOwnerFailureEvidence({schema:'xuan.owner-failure-evidence.v1',validatorPhase:OWNER_FAILURE_VALIDATOR_PHASES.includes(validatorPhase)?validatorPhase:null,
    validatorPoint:OWNER_FAILURE_VALIDATOR_POINTS.includes(validatorPoint)?validatorPoint:null,originalCode,
    origin:finiteOrigin(ownData(error,'safeOrigin'))??safeErrorOrigin(error),read:safeOwnerReadDiagnostics(ownData(error,'ownerReadDiagnostics'))});
}

export function uniqueCloudJson(text,limit=8_000_000) {
  try { parseDecisionJson(text,limit); return JSON.parse(text); }
  catch { throw ibError('CLOUD_RESPONSE_INVALID',{category:'response_invalid'}); }
}
export function validateIbCredentialBinding(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!=='clientId|version'
    ||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value'))
    ||typeof value.version!=='string'||! /^[1-9]\d{0,29}$/.test(value.version)
    ||typeof value.clientId!=='string'||! /^[A-Za-z0-9._:-]{1,200}$/.test(value.clientId))
    throw ibError('IB_READ_ONLY_CREDENTIAL_REQUIRED',{phase:'credential_load',category:'scope_invalid'});
  return Object.freeze({clientId:value.clientId,version:value.version});
}
export function validateBoundIbVersionName(name,version) {
  validateIbCredentialBinding({clientId:'version-check',version});
  if(typeof name!=='string'||!new RegExp('^projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/'+version+'$').test(name))
    throw ibError('IB_READ_ONLY_CREDENTIAL_REQUIRED',{phase:'credential_load',category:'scope_invalid'});
  return name;
}

// Secret Manager can use the fixed project ID or its fixed numeric identifier
// in a version name. Return metadata only; never read the new payload back.
export function validateIbRotationReceipt(value) {
  if (value?.state !== 'ENABLED' || typeof value?.name !== 'string'
    || !/^projects\/(?:family-portfolio-gateway|860729177589)\/secrets\/xuan-preopen-ib-mcp\/versions\/[1-9]\d{0,29}$/.test(value.name))
    throw ibError('IB_TOKEN_ROTATION_OUTCOME_UNKNOWN', {phase: 'credential_save', category: 'save_outcome_unknown'});
  return Object.freeze({name: value.name, state: 'ENABLED'});
}

export async function boundedText(response, limit = 8_000_000,diagnostics) {
  const started=performance.now();let size=0;
  try{
  if (!response.body) throw new Error('CLOUD_EMPTY_RESPONSE');
  const reader = response.body.getReader(), chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('CLOUD_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let text;try { text=new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { throw new Error('CLOUD_INVALID_UTF8'); }
  publishReadDiagnostics(diagnostics,safeOwnerReadDiagnostics({schema:'xuan.owner-read-diagnostics.v1',requestClass:'other',readStage:'body',httpStatus:safeErrorOrigin(null,response).httpStatus,
    observedBodyBytes:size,bodyLimitBytes:limit,elapsedMs:Math.max(0,Math.floor(performance.now()-started)),timeoutMs:null,origin:safeErrorOrigin(null,response)}));
  return text;
  }catch(error){
    try{
    attachOwnerReadDiagnostics(error,{readStage:'body',httpStatus:safeErrorOrigin(error,response).httpStatus,observedBodyBytes:size,bodyLimitBytes:limit,
      elapsedMs:Math.max(0,Math.floor(performance.now()-started))});
    }catch{}
    throw error;
  }
}

export function privateCloudIo({fetchImpl = fetch, now = Date.now} = {}) {
  let googleToken, googleTokenPromise;
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30_000)}); }
    catch (error) { throw ibError('CLOUD_NETWORK_FAILED', {category: networkCategory(error)}); }
    if (!response.ok) throw ibError(`CLOUD_HTTP_${response.status}`, {httpStatus: response.status, category: httpCategory(response.status)});
    try { return uniqueCloudJson(await boundedText(response)); }
    catch (error) { throw inIbPhase(error, 'unknown', 'CLOUD_RESPONSE_INVALID', response.status, 'response_invalid'); }
  }
  async function headers() {
    if (!googleToken) {
      googleTokenPromise ??= request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        {headers: {'Metadata-Flavor': 'Google'}}).then(result=>{
          if (!result.access_token) throw new Error('CLOUD_IDENTITY_UNAVAILABLE');
          return result.access_token;
        });
      googleToken = await googleTokenPromise;
    }
    return {Authorization: `Bearer ${googleToken}`, 'content-type': 'application/json'};
  }
  async function secret(name, version='latest') {
    const result = await request(`https://secretmanager.googleapis.com/v1/${name}/versions/${version}:access`, {headers: await headers()});
    if (!result.payload?.data) throw new Error('CLOUD_CREDENTIAL_UNAVAILABLE');
    return Buffer.from(result.payload.data, 'base64').toString('utf8');
  }
  let activeLease=null;
  const mutex=createIbCredentialLease({now,
    read:async()=>{
      let metadata;try{metadata=await request(LOCK_META,{headers:await headers()});}
      catch(error){if(error?.message==='CLOUD_HTTP_404')return {value:null,generation:'0'};throw error;}
      if(metadata.name!==IB_CREDENTIAL_LOCK_KEY||!/^[1-9]\d*$/.test(String(metadata.generation))
        ||!Number.isSafeInteger(Number(metadata.size))||Number(metadata.size)<0||Number(metadata.size)>4096)throw lockError('IB_CREDENTIAL_LEASE_INVALID');
      const value=await request(LOCK_META+'?alt=media&generation='+metadata.generation,{headers:await headers()});
      return {value,generation:String(metadata.generation)};
    },
    cas:async(generation,value)=>{
      const body=Buffer.from(JSON.stringify(value)),url=new URL(LOCK_UPLOAD);
      url.searchParams.set('uploadType','media');url.searchParams.set('name',IB_CREDENTIAL_LOCK_KEY);url.searchParams.set('ifGenerationMatch',generation);
      const result=await request(url,{method:'POST',headers:await headers(),body});
      if(result.name!==IB_CREDENTIAL_LOCK_KEY||String(result.size)!==String(body.length)||!/^[1-9]\d*$/.test(String(result.generation)))throw lockError('IB_CREDENTIAL_LEASE_OUTCOME_UNKNOWN');
      return String(result.generation);
    }});
  const leaseRequired=()=>{if(!activeLease)throw lockError('IB_CREDENTIAL_LEASE_REQUIRED');return activeLease;};
  return {
    ibStore: {
      requiresCredentialLease:true,
      async withCredentialLease(callback){return mutex.run(async lease=>{activeLease=lease;try{return await callback(lease);}finally{activeLease=null;}});},
      async load() {
        const lease=leaseRequired();await lease.assertLoading();
        try { const result=await request(`https://secretmanager.googleapis.com/v1/${IB_SECRET}/versions/latest:access`,{headers:await headers()});
          const version=String(result.name).split('/').at(-1);validateBoundIbVersionName(result.name,version);lease.loaded(version);
          if(typeof result.payload?.data!=='string')throw Error('invalid');
          return uniqueCloudJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(result.payload.data,'base64'))); }
        catch (error) { throw inIbPhase(error, 'credential_load', 'CLOUD_IB_CREDENTIAL_UNAVAILABLE', null, 'response_invalid'); }
      },
      async loadBound(binding) {
        const {version,clientId}=validateIbCredentialBinding(binding);
        const lease=leaseRequired();await lease.assertLoading(version);
        try {
          const result=await request(`https://secretmanager.googleapis.com/v1/${IB_SECRET}/versions/${version}:access`,{headers:await headers()});
          const versionName=validateBoundIbVersionName(result.name,version),encoded=result.payload?.data;
          if(typeof encoded!=='string'||!encoded||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('invalid');
          const credential=uniqueCloudJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(encoded,'base64')));
          if(!credential||Object.getPrototypeOf(credential)!==Object.prototype||credential.client_id!==clientId)
            throw ibError('IB_READ_ONLY_CREDENTIAL_REQUIRED',{phase:'credential_load',category:'scope_invalid'});
          lease.loaded(version);
          return {credential,versionName};
        }catch(error){throw inIbPhase(error,'credential_load','CLOUD_IB_CREDENTIAL_UNAVAILABLE',null,'response_invalid');}
      },
      async save(value) {
        const lease=leaseRequired();await lease.beforeSave();
        const result = await request(`https://secretmanager.googleapis.com/v1/${IB_SECRET}:addVersion`,
          {method: 'POST', headers: await headers(), body: JSON.stringify({payload: {data: Buffer.from(JSON.stringify(value)).toString('base64')}})});
        const receipt=validateIbRotationReceipt(result);lease.saved(receipt.name);return receipt;
      },
    },
    async loadGatewayToken() {
      const value = (await secret(READ_SECRET)).trim();
      if (!value || /[\r\n]/.test(value)) throw new Error('CLOUD_GATEWAY_CREDENTIAL_INVALID');
      return value;
    },
    async loadFlexToken() {
      const value = (await secret(FLEX_SECRET,'1')).trim();
      if (!value || /[\r\n\0]/.test(value)) throw new Error('FLEX_SOURCE_CONFIGURATION_REQUIRED');
      return value;
    },
    async savePrivate(name, value) {
      if (!/^report-check\/[a-zA-Z0-9:._-]+\/[a-zA-Z0-9._-]+$/.test(name)
          && !/^delivery\/\d{4}-\d{2}-\d{2}\/(report\.html|receipt\.json|start\.json)$/.test(name)) throw new Error('PRIVATE_OBJECT_PATH_INVALID');
      const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
      url.searchParams.set('uploadType', 'media'); url.searchParams.set('name', name); url.searchParams.set('ifGenerationMatch', '0');
      const result = await request(url, {method: 'POST', headers: {...await headers(), 'content-type': 'application/octet-stream'}, body: data});
      if (result.name !== name || String(result.size) !== String(data.length) || !result.generation) throw new Error('PRIVATE_UPLOAD_NOT_CONFIRMED');
      return {sha256: crypto.createHash('sha256').update(data).digest('hex'), generation: String(result.generation)};
    },
  };
}
