// Existing local owner SDK only. No token/env/Keychain export, credential CLI,
// global fetch fallback, arbitrary API, automatic retry or startup side effect.
import {spawn} from 'node:child_process';
import {realpathSync,statSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
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
const fail=code=>Object.assign(Error(`OWNER_SDK_${code}`),{safeCode:code});
const plain=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const generation=x=>typeof x==='string'&&/^[1-9][0-9]{0,29}$/.test(x);

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
    ||typeof value.body!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body))throw fail('RESPONSE_INVALID');
  const bytes=Buffer.from(value.body,'base64');if(bytes.length>4*1024*1024)throw fail('RESPONSE_SIZE_LIMIT');
  const response=new Response([204,205,304].includes(value.status)||!bytes.length?null:bytes,{status:value.status,headers:value.headers});
  Object.defineProperty(response,'url',{value:value.url});return response;
}

export function createOwnerSdkTransport(){
  // Construction is inert. Even process creation waits for a validated call.
  let child,closed=false,busy=false,sequence=0,pending,buffer='',writeStarted=false,canaryAttempted=false,mutationStarted=false;
  const close=(code='CLOSED')=>{
    if(closed)return;closed=true;
    pending?.reject(fail(code));pending=null;
    if(child){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill('SIGKILL');}
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
        if(!pending||!plain(message)||message.id!==pending.id||Object.keys(message).sort().join('|')!==(message.error===undefined?'id|result':'error|id')){close('FRAME_INVALID');return;}
        const receiver=pending;pending=null;
        if(message.error!==undefined){
          if(typeof message.error!=='string'||! /^[A-Z][A-Z0-9_]{1,79}$/.test(message.error)){close('FRAME_INVALID');receiver.reject(fail('FRAME_INVALID'));return;}
          receiver.reject(fail(message.error));
          if(message.error==='REQUEST_OUTCOME_UNKNOWN')close('REQUEST_OUTCOME_UNKNOWN');
        }else receiver.resolve(message.result);
      }
    });
  };
  const call=async(value,{signal,timeoutMs=60000}={})=>{
    if(closed)throw fail('CLOSED');if(signal?.aborted){close('ABORTED');throw fail('ABORTED');}if(busy)throw fail('CONCURRENT_OPERATION');
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
    close
  });
}
