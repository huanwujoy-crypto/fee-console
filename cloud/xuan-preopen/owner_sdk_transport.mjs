// Existing local owner SDK only. No token/env/Keychain export, credential CLI,
// global fetch fallback, arbitrary API, automatic retry or startup side effect.
import {spawn} from 'node:child_process';
import {realpathSync,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {types as utilTypes} from 'node:util';
import {recoveryRequestId,originalReportStart} from './owner_bundle_contract.mjs';
import {registeredOwnerRecovery} from './owner_source_recovery.mjs';
import {LATEST_TARGET,MAX_BYTES} from './owner_latest.mjs';
import {validatePreviewReplacementRegistration,previewReplacementRegistrationText,acceptedPreviewRegistrationText} from './owner_accepted_preview.mjs';

export const OWNER_SDK_PYTHON='/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12';
export const OWNER_SDK_CONFIG='/Users/huanwu/.config/gcloud';
export const OWNER_SDK_ACCOUNT_SHA256='1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee';
export const OWNER_SDK_ROOT_SHA256='01686f458b748b5277840da752f9c73b4f29de6ae520151c61a45d784b8bc8fa';
const worker=fileURLToPath(new URL('./owner_sdk_transport.py',import.meta.url));
const maxFrame=24*1024*1024,base=`https://storage.googleapis.com/storage/v1/b/${LATEST_TARGET.bucket}/o/`;
const latest=base+encodeURIComponent(LATEST_TARGET.object);
const upload=`https://storage.googleapis.com/upload/storage/v1/b/${LATEST_TARGET.bucket}/o`;
const fail=(code,diagnostics=null,cleanup=Object.freeze([]),localCodes=[])=>attachDiagnostics(Object.assign(Error(`OWNER_SDK_${code}`),{safeCode:code}),diagnostics,cleanup,localCodes);
const plain=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const generation=x=>typeof x==='string'&&/^[1-9][0-9]{0,29}$/.test(x);

export const OWNER_SAFE_DIAGNOSTIC_STAGES=Object.freeze(["frame", "request-validation", "identity", "cache", "metadata-get", "html-get", "head", "boundary", "canary", "cas", "readback-metadata", "readback-html", "close"]);
export const OWNER_SAFE_ERROR_TYPES=Object.freeze(["BoundaryError", "OSError", "TimeoutError", "ConnectionError", "SSLError", "SSLCertVerificationError", "CertificateError", "BrokenPipeError", "ConnectionResetError", "ConnectionRefusedError", "FileNotFoundError", "PermissionError", "ImportError", "ModuleNotFoundError", "ValueError", "TypeError", "RuntimeError", "RequestException", "ReadTimeout", "ConnectTimeout", "ConnectTimeoutError", "ReadTimeoutError", "ProxyError", "NewConnectionError", "MaxRetryError", "TransportError", "RefreshError", "gaierror"]);
export const OWNER_SAFE_ERROR_CODES=Object.freeze(["BODY_INVALID", "BOUNDARY_ACCESS_DENIED", "BOUNDARY_CONTENT_TYPE", "BOUNDARY_READ_FAILED", "CACHED_CREDENTIAL_LIFETIME_INSUFFICIENT", "CACHED_CREDENTIAL_REFRESH_REQUIRED", "CANARY_ALREADY_ATTEMPTED", "CANARY_ALREADY_EXISTS", "CANARY_INVALID", "CANARY_PRESENCE_UNPROVEN", "CANARY_REQUEST_INVALID", "CANARY_TIME_INVALID", "CLOSED", "DISPLAY_UTF8_INVALID", "DUPLICATE_JSON_KEY", "EACCES", "EAI_AGAIN", "EAI_NONAME", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENCODING_INVALID", "ENETUNREACH", "ENOENT", "ENVIRONMENT_OVERRIDE", "EPERM", "EPIPE", "ETIMEDOUT", "EXISTING_USER_CREDENTIAL_REQUIRED", "FRAME_INVALID", "FRAME_SIZE_LIMIT", "HEADERS_INVALID", "JSON_INVALID", "MULTIPART_INVALID", "MULTIPART_METADATA_INVALID", "MULTIPART_RESOURCE_INVALID", "OPERATION_INVALID", "ORIGINAL_IDENTITY_CHANGED", "ORIGINAL_IDENTITY_REQUIRED", "PIN_REQUIRED", "QUERY_INVALID", "READ_FAILED", "REDIRECT_OR_URL_CHANGED", "REPLACEMENT_ADMISSION_EXPIRED", "REPLACEMENT_CANARY_CURRENT", "REPLACEMENT_CANARY_REGISTRATION", "REPLACEMENT_CANDIDATE", "REPLACEMENT_INVALID", "REPLACEMENT_METADATA", "REPLACEMENT_OLD_CHANGED", "REPLACEMENT_OLD_HASH", "REPLACEMENT_OLD_MEDIA", "REPLACEMENT_OLD_METADATA", "REPLACEMENT_REGISTRATION", "REQUEST_INVALID", "REQUEST_OUTCOME_UNKNOWN", "RESPONSE_SIZE_LIMIT", "SDK_CONFIG_INVALID", "SDK_FAILED", "SDK_OVERRIDE", "SDK_ROOT_INVALID", "SDK_ROOT_REQUIRED", "TARGET_INVALID", "TLS_CERTIFICATE_ERROR", "TLS_ERROR", "WRITE_ALREADY_ATTEMPTED"]);

const SAFE_DIAGNOSTIC_KEYS=Object.freeze(['schema','stage','errorType','errorCode','causeCode','httpStatus','casHttpAttempts','casHttpAcks','readbackMetadataAttempts','readbackMetadataSuccesses','readbackHtmlAttempts','readbackHtmlSuccesses']);
const COUNTERS=SAFE_DIAGNOSTIC_KEYS.slice(6);
const ownData=(x,keys)=>{if(utilTypes.isProxy(x)||!plain(x))return false;const d=Object.getOwnPropertyDescriptors(x);return Reflect.ownKeys(d).length===keys.length&&keys.every(k=>Object.hasOwn(d,k)&&Object.hasOwn(d[k],'value'));};
export function decodeOwnerSafeDiagnostics(value){
  try{
    if(!ownData(value,SAFE_DIAGNOSTIC_KEYS)||value.schema!=='xuan.owner-sdk.safe-diagnostics.v1'||!OWNER_SAFE_DIAGNOSTIC_STAGES.includes(value.stage)
      ||!(value.errorType===null||OWNER_SAFE_ERROR_TYPES.includes(value.errorType))||!(value.errorCode===null||OWNER_SAFE_ERROR_CODES.includes(value.errorCode))
      ||!(value.causeCode===null||OWNER_SAFE_ERROR_CODES.includes(value.causeCode))||!(value.httpStatus===null||(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599))
      ||COUNTERS.some(k=>!Number.isSafeInteger(value[k])||value[k]<0)||value.casHttpAttempts>1||value.casHttpAcks>value.casHttpAttempts
      ||value.readbackMetadataSuccesses>value.readbackMetadataAttempts||value.readbackHtmlSuccesses>value.readbackHtmlAttempts)return null;
    return Object.freeze(Object.fromEntries(SAFE_DIAGNOSTIC_KEYS.map(k=>[k,value[k]])));
  }catch{return null;}
}
function decodeCleanup(value,primary){
  if(utilTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>1)return null;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(k=>k!=='length'&&k!=='0')||(value.length===1&&(!descriptors['0']||!Object.hasOwn(descriptors['0'],'value'))))return null;
  const result=[];for(const raw of value){const d=decodeOwnerSafeDiagnostics(raw);if(!d||d.stage!=='close'||COUNTERS.some(k=>d[k]!==primary[k]))return null;result.push(d);}return Object.freeze(result);
}
function attachDiagnostics(value,diagnostics=null,cleanup=Object.freeze([]),localCodes=[]){
  if(value!==null&&(typeof value==='object'||typeof value==='function')){
    Object.defineProperty(value,'ownerSafeDiagnostics',{value:diagnostics,enumerable:false,writable:false,configurable:false});
    Object.defineProperty(value,'ownerSafeCleanupDiagnostics',{value:cleanup,enumerable:false,writable:false,configurable:false});
    Object.defineProperty(value,'ownerSafeLocalCleanupCodes',{value:Object.freeze([...localCodes]),enumerable:false,writable:false,configurable:false});
  }return value;
}

function environment(){
  const forbidden=/^(?:CLOUDSDK_AUTH_|CLOUDSDK_API_ENDPOINT_OVERRIDES_|CLOUDSDK_CORE_ACCOUNT$|CLOUDSDK_ACTIVE_CONFIG_NAME$|CLOUDSDK_CORE_UNIVERSE_DOMAIN$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_AUTH_ACCESS_TOKEN$|GOOGLE_API_USE_CLIENT_CERTIFICATE$|GOOGLE_API_USE_MTLS_ENDPOINT$|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$|SSL_CERT_FILE$|SSL_CERT_DIR$|(?:HTTPS?|ALL)_PROXY$)/i;
  if(Object.entries(process.env).some(([key,value])=>value&&forbidden.test(key)))throw fail('ENVIRONMENT_OVERRIDE');
  if(process.env.CLOUDSDK_CONFIG&&process.env.CLOUDSDK_CONFIG!==OWNER_SDK_CONFIG)throw fail('SDK_CONFIG_INVALID');
  if(!process.env.XUAN_OWNER_EXISTING_SDK_ROOT)throw fail('SDK_ROOT_REQUIRED');
  let sdkRoot;try{sdkRoot=realpathSync(process.env.XUAN_OWNER_EXISTING_SDK_ROOT);if(!statSync(sdkRoot).isDirectory())throw Error();}catch{throw fail('SDK_ROOT_INVALID');}
  if(createHash('sha256').update(sdkRoot).digest('hex')!==OWNER_SDK_ROOT_SHA256)throw fail('SDK_ROOT_INVALID');
  // Keep only ordinary OS/runtime values. Python import paths and credentials
  // cannot be injected through inherited environment variables.
  const env=Object.fromEntries(['HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','PATH'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  return {...env,XUAN_OWNER_EXISTING_SDK_ROOT:sdkRoot,CLOUDSDK_CONFIG:OWNER_SDK_CONFIG,CLOUDSDK_CORE_DISABLE_PROMPTS:'true',
    CLOUDSDK_CORE_LOG_HTTP:'false',CLOUDSDK_CORE_VERBOSITY:'error',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK:'true',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'};
}

function requestValue(input,options={},expectedGeneration='0'){
  if(typeof input!=='string'||!plain(options)||Object.keys(options).some(k=>!['method','headers','body','signal','redirect'].includes(k)))throw fail('REQUEST_INVALID');
  const {method='GET',headers={},body,redirect='error'}=options;
  if(redirect!=='error'||!['HEAD','GET','POST'].includes(method)||!plain(headers))throw fail('REQUEST_INVALID');
  let url;try{url=new URL(input);}catch{throw fail('TARGET_INVALID');}
  if(url.href!==input||url.origin!=='https://storage.googleapis.com'||url.hash||url.username||url.password)throw fail('TARGET_INVALID');
  const pairs=[...url.searchParams],query=Object.fromEntries(pairs);
  if(pairs.length!==Object.keys(query).length)throw fail('QUERY_INVALID');
  const normalized=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
  if(Object.keys(normalized).length!==Object.keys(headers).length||Object.values(normalized).some(v=>typeof v!=='string'))throw fail('HEADERS_INVALID');
  const keys=Object.keys(normalized).sort().join('|');
  if(method==='POST'){
    if(url.origin+url.pathname!==upload||Object.keys(query).sort().join('|')!=='ifGenerationMatch|uploadType'||query.uploadType!=='multipart'||query.ifGenerationMatch!==expectedGeneration)throw fail('TARGET_INVALID');
    if(Object.hasOwn(normalized,'accept-encoding')&&normalized['accept-encoding']!=='identity')throw fail('HEADERS_INVALID');
    if(!['accept|content-type','accept|accept-encoding|content-type'].includes(keys)||normalized.accept!=='application/json'||!/^multipart\/related; boundary=xuan_owner_latest_[a-f0-9]{64}$/.test(normalized['content-type'])
      ||!(body instanceof Uint8Array)||!body.length||body.length>MAX_BYTES+32768)throw fail('MULTIPART_INVALID');
    // Preserve the store API; every outgoing POST frame fixes negotiation.
    normalized['accept-encoding']='identity';
  }else{
    if(url.origin+url.pathname!==latest||body!==undefined)throw fail('TARGET_INVALID');
    if(method==='HEAD'){
      if(Object.keys(query).join('|')!=='alt'||query.alt!=='media'||keys!=='accept-encoding'||normalized['accept-encoding']!=='identity')throw fail('REQUEST_INVALID');
    }else{
      if(keys!=='accept|accept-encoding'||normalized['accept-encoding']!=='identity')throw fail('HEADERS_INVALID');
      if(query.alt==='media'){
        if(Object.keys(query).sort().join('|')!=='alt|generation'||!generation(query.generation)||normalized.accept!=='application/octet-stream')throw fail('PIN_REQUIRED');
      }else if(Object.keys(query).some(k=>k!=='generation')||('generation'in query&&!generation(query.generation))||normalized.accept!=='application/json')throw fail('REQUEST_INVALID');
    }
  }
  return {op:'request',url:input,method,headers:normalized,body:body===undefined?null:Buffer.from(body).toString('base64')};
}

// Separate named lane; request() and the registered-preview lane stay narrow.
// Python additionally authorizes source pins from the actual receipt read.
function dailyRequestValue(input,options={},admissionExpiresAt){
  const method=options.method??'GET';
  if(method==='POST'){
    let u;try{u=new URL(input);}catch{throw fail('TARGET_INVALID');}
    const expected=u.searchParams.get('ifGenerationMatch');
    if(!generation(expected)||!Number.isSafeInteger(admissionExpiresAt)
      ||Date.now()>admissionExpiresAt||admissionExpiresAt>Date.now()+5000)throw fail('REPLACEMENT_ADMISSION_EXPIRED');
    return {...requestValue(input,options,expected),op:'dailyRequest',admissionExpiresAt};
  }
  if(input.startsWith(latest))return {...requestValue(input,options),op:'dailyRequest'};
  let u;try{u=new URL(input);}catch{throw fail('TARGET_INVALID');}
  const prefix='/storage/v1/b/'+LATEST_TARGET.bucket+'/o/';
  let name;try{name=decodeURIComponent(u.pathname.slice(prefix.length));}catch{throw fail('TARGET_INVALID');}
  if(u.origin!=='https://storage.googleapis.com'||!u.pathname.startsWith(prefix)
    ||u.pathname!==prefix+encodeURIComponent(name)||(!(/^(delivery\/\d{4}-\d\d-\d\d\/(?:report\.html|receipt\.json)|report-check\/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z-[a-f0-9-]{36}\/(?:ib\.flexEod|sharesight\.ibGroupedPerformance|sharesight\.noahPerformance|ib\.optionalLive)\.json)$/.test(name))
    && !recoveryRequestId(name)&&!originalReportStart(name))
    ||method!=='GET')throw fail('TARGET_INVALID');
  // Reuse the existing strict scheme/query/header/body validation.
  const value=requestValue(input.replace(u.pathname,new URL(latest).pathname),options);
  if(name.startsWith('report-check/')&&!u.searchParams.has('generation')
    &&(name!==registeredOwnerRecovery().receiptObject||u.searchParams.has('alt')))throw fail('PIN_REQUIRED');
  return {...value,op:'dailyRequest',url:input};
}

function replacementValue(url,options,pins){
  if(!plain(pins)||Object.keys(pins).sort().join('|')!=='previousDisplaySha256|previousGeneration|previousRegistrationSha256|revisionSha256'
    ||!generation(pins.previousGeneration))throw fail('REPLACEMENT_INVALID');
  const read=file=>readFileSync(new URL('../../security/'+file,import.meta.url));
  let revision,revisionBytes;const hash=b=>createHash('sha256').update(b).digest('hex');
  try{revisionBytes=read('xuan-owner-preview-replacement.json');
    const oldBytes=read('xuan-owner-accepted-preview.json'),old=JSON.parse(oldBytes.toString('utf8'));
    revision=validatePreviewReplacementRegistration(JSON.parse(revisionBytes.toString('utf8')),{previousRegistration:old,
      previousRegistrationSha256:hash(oldBytes),canaryRegistrationSha256:hash(read('xuan-owner-registered-canary.json'))});
    if(previewReplacementRegistrationText(revision)!==revisionBytes.toString('utf8'))throw Error();
  }catch{throw fail('REPLACEMENT_REGISTRATION');}
  if(pins.revisionSha256!==hash(revisionBytes)||pins.previousRegistrationSha256!==revision.previousRegistrationSha256
    ||pins.previousDisplaySha256!==revision.previousDisplaySha256)throw fail('REPLACEMENT_INVALID');
  const value=requestValue(url,options,pins.previousGeneration);
  if(value.method!=='POST')throw fail('REPLACEMENT_INVALID');
  const raw=Buffer.from(value.body,'base64'),boundary='xuan_owner_latest_'+revision.registration.displaySha256;
  const prefix=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'),separator=Buffer.from('\r\n--'+boundary+'\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'),suffix=Buffer.from('\r\n--'+boundary+'--\r\n');
  try{const offset=raw.indexOf(separator),resource=JSON.parse(raw.subarray(prefix.length,offset).toString('utf8'));
    const display=raw.subarray(offset+separator.length,raw.length-suffix.length),metadata=JSON.parse(resource.metadata.previewMetadata);
    if(!raw.subarray(0,prefix.length).equals(prefix)||!raw.subarray(-suffix.length).equals(suffix)||offset<0
      ||resource.name!==LATEST_TARGET.object||resource.metadata.displaySha256!==revision.registration.displaySha256
      ||hash(display)!==revision.registration.displaySha256||metadata.registrationSha256!==hash(acceptedPreviewRegistrationText(revision.registration)))throw Error();
  }catch{throw fail('REPLACEMENT_CANDIDATE');}
  return {...value,op:'replaceAcceptedPreview',replacement:structuredClone(pins)};
}

function nativeResponse(value){
  if(!plain(value)||Object.keys(value).sort().join('|')!=='body|headers|status|url'||!Number.isInteger(value.status)||value.status<200||value.status>599||typeof value.url!=='string'
    ||!plain(value.headers)||Object.entries(value.headers).some(([k,v])=>!['content-type','content-length','content-disposition','cache-control','content-encoding','x-goog-generation'].includes(k)||typeof v!=='string')
    ||typeof value.body!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body))throw fail('RESPONSE_INVALID',value?.ownerSafeDiagnostics??null,value?.ownerSafeCleanupDiagnostics??Object.freeze([]),value?.ownerSafeLocalCleanupCodes??[]);
  const bytes=Buffer.from(value.body,'base64');if(bytes.length>4*1024*1024)throw fail('RESPONSE_SIZE_LIMIT',value.ownerSafeDiagnostics,value.ownerSafeCleanupDiagnostics,value.ownerSafeLocalCleanupCodes);
  try{const response=new Response([204,205,304].includes(value.status)||!bytes.length?null:bytes,{status:value.status,headers:value.headers});
  Object.defineProperty(response,'url',{value:value.url});return attachDiagnostics(response,value.ownerSafeDiagnostics,value.ownerSafeCleanupDiagnostics,value.ownerSafeLocalCleanupCodes);
  }catch(error){throw attachDiagnostics(error,value.ownerSafeDiagnostics,value.ownerSafeCleanupDiagnostics,value.ownerSafeLocalCleanupCodes);}
}

export function createOwnerSdkTransport(){
  // Construction is inert. Even process creation waits for a validated call.
  let child,closed=false,busy=false,sequence=0,pending,buffer='',writeStarted=false,canaryAttempted=false,mutationStarted=false,lastCounters=null,localCleanupCodes=[];
  const close=(code='CLOSED',explicit=false)=>{
    if(closed){if(explicit&&localCleanupCodes.length)throw fail('SDK_LOCAL_CLOSE_FAILED',null,Object.freeze([]),localCleanupCodes);return;}
    closed=true;const receiver=pending;pending=null;
    if(child){for(const stream of [child.stdin,child.stdout,child.stderr]){try{stream.destroy();}catch{if(!localCleanupCodes.length)localCleanupCodes=['SDK_LOCAL_CLOSE_FAILED'];}}try{child.kill('SIGKILL');}catch{if(!localCleanupCodes.length)localCleanupCodes=['SDK_LOCAL_CLOSE_FAILED'];}}
    if(receiver)receiver.reject(fail(code,null,Object.freeze([]),localCleanupCodes));
    else if(explicit&&localCleanupCodes.length)throw fail('SDK_LOCAL_CLOSE_FAILED',null,Object.freeze([]),localCleanupCodes);
  };
  const start=()=>{
    if(child)return;
    child=spawn(OWNER_SDK_PYTHON,['-I','-B',worker],{env:environment(),stdio:['pipe','pipe','pipe'],shell:false});
    // Never relay stderr: SDK exception/log text is outside the safe protocol.
    child.stderr.on('data',()=>{});
    child.on('error',()=>close('WORKER_FAILED'));
    child.on('exit',()=>close(mutationStarted?'REQUEST_OUTCOME_UNKNOWN':'WORKER_CLOSED'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(Buffer.byteLength(buffer)>maxFrame){close('FRAME_SIZE_LIMIT');return;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let message;try{message=JSON.parse(line);}catch{close('FRAME_INVALID');return;}
        if(!pending||!plain(message)||message.id!==pending.id||Object.keys(message).sort().join('|')!==(message.error===undefined?'id|result|safeCleanupDiagnostics|safeDiagnostics':'error|id|safeCleanupDiagnostics|safeDiagnostics')){close('FRAME_INVALID');return;}
        if(message.error===undefined&&(!plain(message.result)||Object.hasOwn(message.result,'ownerSafeDiagnostics')||Object.hasOwn(message.result,'ownerSafeCleanupDiagnostics')||Object.hasOwn(message.result,'ownerSafeLocalCleanupCodes'))){close('FRAME_INVALID');return;}
        const diagnostics=decodeOwnerSafeDiagnostics(message.safeDiagnostics),cleanup=diagnostics?decodeCleanup(message.safeCleanupDiagnostics,diagnostics):null;
        if(!diagnostics||!cleanup||(lastCounters&&COUNTERS.some(k=>diagnostics[k]<lastCounters[k]))){close('FRAME_INVALID');return;}
        lastCounters=diagnostics;
        const receiver=pending;pending=null;
        if(message.error!==undefined){
          if(typeof message.error!=='string'||!OWNER_SAFE_ERROR_CODES.includes(message.error)){close('FRAME_INVALID');receiver.reject(fail('FRAME_INVALID',null,Object.freeze([]),localCleanupCodes));return;}
          if(message.error==='REQUEST_OUTCOME_UNKNOWN')close('REQUEST_OUTCOME_UNKNOWN');
          receiver.reject(fail(message.error,diagnostics,cleanup,localCleanupCodes));
        }else receiver.resolve(attachDiagnostics(message.result,diagnostics,cleanup));
      }
    });
  };
  const call=async(value,{signal,timeoutMs=60000}={})=>{
    if(closed)throw fail('CLOSED',null,Object.freeze([]),localCleanupCodes);if(signal?.aborted){close('ABORTED');throw fail('ABORTED',null,Object.freeze([]),localCleanupCodes);}if(busy)throw fail('CONCURRENT_OPERATION');
    busy=true;
    let timer;const abort=()=>close(mutationStarted?'REQUEST_OUTCOME_UNKNOWN':'ABORTED');
    try{
      start();const id=++sequence;
      const promise=new Promise((resolve,reject)=>{pending={id,resolve,reject};});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return await promise;}
      timer=setTimeout(()=>close(mutationStarted?'REQUEST_OUTCOME_UNKNOWN':'TIMEOUT'),timeoutMs);timer.unref?.();
      const frame=JSON.stringify({id,value})+'\n';if(Buffer.byteLength(frame)>maxFrame)throw fail('FRAME_SIZE_LIMIT');
      child.stdin.write(frame,error=>{if(error)close(mutationStarted?'REQUEST_OUTCOME_UNKNOWN':'WORKER_FAILED');});
      return await promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);busy=false;}
  };
  return Object.freeze({
    async requestDaily(url,options={}, {admissionExpiresAt}={}){
      const value=dailyRequestValue(url,options,admissionExpiresAt);
      if(value.method==='POST'){
        if(writeStarted)throw fail('WRITE_ALREADY_ATTEMPTED');
        writeStarted=true;mutationStarted=true;
      }
      return nativeResponse(await call(value,{signal:options.signal}));
    },
    async request(url,options={}){
      const value=requestValue(url,options);
      if(value.method==='POST'){if(writeStarted)throw fail('WRITE_ALREADY_ATTEMPTED');writeStarted=true;mutationStarted=true;}
      return nativeResponse(await call(value,{signal:options.signal}));
    },
    async requestPreviewReplacement(url,options={},pins,{admissionExpiresAt}={}){
      const value=replacementValue(url,options,pins);
      const time=Date.now();if(!Number.isSafeInteger(admissionExpiresAt)||time>admissionExpiresAt||time<admissionExpiresAt-5000)throw fail('REPLACEMENT_ADMISSION_EXPIRED');
      if(writeStarted)throw fail('WRITE_ALREADY_ATTEMPTED');writeStarted=true;mutationStarted=true;
      return nativeResponse(await call({...value,admissionExpiresAt},{signal:options.signal}));
    },
    async checkOriginalIdentity({signal}={}){return call({op:'identity'},{signal});},
    async readLiveBoundary({includeRoleDefinitions=true,requireDeletePermission=false,signal}={}){
      if(typeof includeRoleDefinitions!=='boolean'||typeof requireDeletePermission!=='boolean')throw fail('REQUEST_INVALID');
      return call({op:'boundary',includeRoleDefinitions,...(requireDeletePermission?{requireDeletePermission:true}:{})},{signal,timeoutMs:120000});
    },
    // Named alias makes the fixed metadata-only capability explicit to callers.
    async readBucketProjectPolicy({includeRoleDefinitions=true,signal}={}){
      if(typeof includeRoleDefinitions!=='boolean')throw fail('REQUEST_INVALID');
      return call({op:'boundary',includeRoleDefinitions},{signal,timeoutMs:120000});
    },
    async createCanary(options={}){
      if(!plain(options)||Object.keys(options).some(k=>!['uuid','createdAt','candidateSha256','signal'].includes(k)))throw fail('CANARY_INVALID');
      const {uuid,createdAt,candidateSha256,signal}=options;
      if(typeof uuid!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid)
        ||typeof createdAt!=='string'||! /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt
        ||Date.parse(createdAt)>Date.now()||Date.now()-Date.parse(createdAt)>60000||typeof candidateSha256!=='string'||! /^[a-f0-9]{64}$/.test(candidateSha256))throw fail('CANARY_INVALID');
      if(canaryAttempted)throw fail('CANARY_ALREADY_ATTEMPTED');canaryAttempted=true;mutationStarted=true;
      return nativeResponse(await call({op:'createCanary',uuid,createdAt,candidateSha256},{signal}));
    },
    async requestCanary({generation:gen,media=true,method='GET',signal}={}){
      if(typeof media!=='boolean'||!['HEAD','GET'].includes(method)||(method==='HEAD'?(gen!==undefined||media!==true):!generation(gen)))throw fail('CANARY_REQUEST_INVALID');
      return nativeResponse(await call({op:'requestCanary',method,generation:gen??null,media},{signal}));
    },
    close:()=>close('CLOSED',true)
  });
}
