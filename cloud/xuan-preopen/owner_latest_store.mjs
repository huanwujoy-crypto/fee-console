// GCS transport adapter for the private owner latest object. The trusted
// controller injects its existing authorized transport; there is no credential,
// environment, global fetch, retry, object listing or arbitrary URL fallback.
import {LATEST_TARGET,LATEST_HEADERS,MAX_BYTES,MAX_RECEIPT_BYTES,sha256,
  ACCEPTED_PREVIEW_SCHEMA,validateAcceptedPreviewMetadata,ownerJsonMediaHeadersMatch} from './owner_latest.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';

export const MAX_METADATA_BYTES=16*1024,MAX_SOURCE_BYTES=8*1024*1024;
const BASE=`https://storage.googleapis.com/storage/v1/b/${LATEST_TARGET.bucket}/o/`;
const UPLOAD=`https://storage.googleapis.com/upload/storage/v1/b/${LATEST_TARGET.bucket}/o`;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const gen=x=>typeof x==='string'&&/^[1-9][0-9]{0,29}$/.test(x);
const obj=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const fail=(code,status)=>{throw Object.assign(Error(`OWNER_LATEST_STORE_${code}`),{safeCode:code,...(status?{status}:{})});};
function sameTarget(target){
  if(target!==undefined&&(!obj(target)||Object.keys(target).sort().join('|')!=='bucket|object'
    ||target.bucket!==LATEST_TARGET.bucket||target.object!==LATEST_TARGET.object))fail('TARGET_INVALID');
}
function exactDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)
    ||!Number.isFinite(Date.parse(value+'T00:00:00.000Z'))
    ||new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value)fail('PATH_INVALID');
}
function dailyName(name,kind){
  const match=typeof name==='string'&&name.match(/^delivery\/(\d{4}-\d\d-\d\d)\/(report\.html|receipt\.json)$/);
  if(!match||(kind&&match[2]!==kind))fail('PATH_INVALID');
  exactDate(match[1]);return name;
}
function sourceName(name){
  // Same strict source-manifest family as eod_report.mjs. This intentionally
  // excludes auth probes, arbitrary report-check objects and ad hoc captures.
  const match=typeof name==='string'&&name.match(/^report-check\/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(ib\.flexEod|sharesight\.ibGroupedPerformance|sharesight\.noahPerformance|ib\.optionalLive)\.json$/);
  if(!match||!Number.isFinite(Date.parse(match[1]))||new Date(match[1]).toISOString()!==match[1])fail('SOURCE_PATH_INVALID');
  return name;
}
function sizeOf(value,max){
  if(typeof value!=='string'||!/^[1-9][0-9]{0,8}$/.test(value)||Number(value)>max)fail('SIZE_INVALID');
  return Number(value);
}
function urlFor(name,generation,{media=false}={}){
  const url=new URL(BASE+encodeURIComponent(name));
  if(generation!==undefined){if(!gen(generation))fail('GENERATION_INVALID');url.searchParams.set('generation',generation);}
  if(media)url.searchParams.set('alt','media');return url.href;
}
function responseOk(response,url,{absent=false,presenceOnly=false}={}){
  if(!(response instanceof Response)||response.redirected||(response.url&&response.url!==url))fail('RESPONSE_INVALID');
  if(absent&&response.status===404)return false;
  if(response.status!==200)fail(response.status===403?'ACCESS_DENIED':response.status===404?'PINNED_OBJECT_MISSING':'HTTP_FAILED',response.status);
  if(presenceOnly)return true;
  if(response.headers.get('content-encoding')&&!/^identity$/i.test(response.headers.get('content-encoding')))fail('ENCODING_INVALID');
  return true;
}
function lengthHeader(response,max,{required=false}={}){
  const value=response.headers.get('content-length');
  if(value===null){if(required)fail('LENGTH_HEADER_REQUIRED');return null;}
  return sizeOf(value,max);
}
async function boundedBytes(response,max){
  const declared=lengthHeader(response,max),reader=response.body?.getReader();
  if(!reader)fail('BODY_REQUIRED');
  let size=0;const chunks=[];
  try{
    while(true){const {done,value}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array)||(size+=value.length)>max){reader.cancel().catch(()=>{});fail('SIZE_LIMIT');}
      chunks.push(new Uint8Array(value));
    }
  }finally{reader.releaseLock();}
  if(size===0||(declared!==null&&declared!==size))fail('LENGTH_MISMATCH');
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function decodeJson(bytes){
  try{const text=decoder.decode(bytes);parseDecisionJson(text,MAX_METADATA_BYTES);return JSON.parse(text);}
  catch{fail('METADATA_JSON_INVALID');}
}
function latestHeaders(value){
  if(value.contentType!==LATEST_HEADERS.contentType||value.contentDisposition!==LATEST_HEADERS.contentDisposition
    ||value.cacheControl!==LATEST_HEADERS.cacheControl)fail('LATEST_HEADERS_INVALID');
}
function latestResponseHeaders(response){
  if(!ownerJsonMediaHeadersMatch({contentType:response.headers.get('content-type'),
    contentDisposition:response.headers.get('content-disposition'),cacheControl:response.headers.get('cache-control')}))fail('LATEST_HEADERS_INVALID');
}
function mediaHeaders(response,{generation,size,latest=false}){
  if(response.headers.get('x-goog-generation')!==generation||lengthHeader(response,latest?MAX_BYTES:MAX_SOURCE_BYTES,{required:true})!==size)
    fail('MEDIA_BINDING_INVALID');
  if(latest)latestResponseHeaders(response);
}
function objectMetadata(value,{name,generation,max,latest=false}){
  if(!obj(value)||value.bucket!==LATEST_TARGET.bucket||value.name!==name||!gen(value.generation)
    ||(generation!==undefined&&value.generation!==generation))fail('METADATA_BINDING_INVALID');
  const size=sizeOf(value.size,max);
  if(latest)latestHeaders(value);
  return {...value,size};
}
function customMetadata(bundleMetadata,displaySha256){
  if(!obj(bundleMetadata)||!hex(displaySha256))fail('CUSTOM_METADATA_INVALID');
  dailyName(bundleMetadata.artifactObject,'report.html');dailyName(bundleMetadata.receiptObject,'receipt.json');
  if(!gen(bundleMetadata.artifactGeneration)||!gen(bundleMetadata.receiptGeneration)
    ||!hex(bundleMetadata.artifactSha256)||!hex(bundleMetadata.receiptSha256))fail('CUSTOM_METADATA_INVALID');
  const value={bundleMetadata:JSON.stringify(bundleMetadata),displaySha256,
    artifactObject:bundleMetadata.artifactObject,artifactGeneration:bundleMetadata.artifactGeneration,artifactSha256:bundleMetadata.artifactSha256,
    receiptObject:bundleMetadata.receiptObject,receiptGeneration:bundleMetadata.receiptGeneration,receiptSha256:bundleMetadata.receiptSha256};
  if(encoder.encode(JSON.stringify(value)).length>MAX_METADATA_BYTES)fail('METADATA_SIZE_LIMIT');
  return value;
}
function previewCustomMetadata(metadata,displaySha256){
  if(!hex(displaySha256))fail('CUSTOM_METADATA_INVALID');
  validateAcceptedPreviewMetadata(metadata);
  const value={previewMetadata:JSON.stringify(Object.fromEntries(Object.keys(metadata).sort().map(key=>[key,metadata[key]]))),displaySha256};
  if(encoder.encode(JSON.stringify(value)).length>MAX_METADATA_BYTES)fail('METADATA_SIZE_LIMIT');
  return value;
}
function parseCustom(value){
  if(!obj(value)||Object.values(value).some(x=>typeof x!=='string')
    ||encoder.encode(JSON.stringify(value)).length>MAX_METADATA_BYTES)fail('CUSTOM_METADATA_INVALID');
  if(Object.hasOwn(value,'previewMetadata')){
    if(Object.keys(value).sort().join('|')!=='displaySha256|previewMetadata')fail('CUSTOM_METADATA_INVALID');
    let metadata;try{metadata=JSON.parse(value.previewMetadata);}catch{fail('CUSTOM_METADATA_INVALID');}
    const expected=previewCustomMetadata(metadata,value.displaySha256);
    if(expected.previewMetadata!==value.previewMetadata)fail('CUSTOM_METADATA_INVALID');
    return {kind:'accepted-preview',preview:metadata,displaySha256:value.displaySha256};
  }
  if(typeof value.bundleMetadata!=='string')fail('CUSTOM_METADATA_INVALID');
  let bundle;
  try{bundle=JSON.parse(value.bundleMetadata);}catch{fail('CUSTOM_METADATA_INVALID');}
  // A single canonical JSON string also rejects duplicated JSON keys.
  if(!obj(bundle)||JSON.stringify(bundle)!==value.bundleMetadata)fail('CUSTOM_METADATA_INVALID');
  const expected=customMetadata(bundle,value.displaySha256);
  if(Object.keys(value).sort().join('|')!==Object.keys(expected).sort().join('|')
    ||Object.keys(expected).some(key=>value[key]!==expected[key]))fail('CUSTOM_METADATA_INVALID');
  return {bundle,displaySha256:value.displaySha256};
}
function concat(...parts){const bytes=new Uint8Array(parts.reduce((n,x)=>n+x.length,0));let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;}
function includesBytes(haystack,needle){outer:for(let i=0;i<=haystack.length-needle.length;i++){
  for(let j=0;j<needle.length;j++)if(haystack[i+j]!==needle[j])continue outer;return true;}return false;}

export function createOwnerLatestStore({request,requestPreviewReplacement}={}){
  if(typeof request!=='function')fail('REQUEST_CAPABILITY_REQUIRED');
  let previewCreateClosed=false,previewReplacementClosed=false,previewWriteStarted=false;
  const send=async(url,{method='GET',headers={},body,signal}={})=>{
    if(signal?.aborted)fail('ABORTED');
    return request(url,{method,headers,...(body===undefined?{}:{body}),signal,redirect:'error'});
  };
  const getMetadata=async(name,generation,max,signal,{latest=false}={})=>{
    const url=urlFor(name,generation),response=await send(url,{signal,headers:{Accept:'application/json','Accept-Encoding':'identity'}});
    responseOk(response,url);
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')||''))fail('METADATA_CONTENT_TYPE');
    const bytes=await boundedBytes(response,MAX_METADATA_BYTES);
    const metadata=objectMetadata(decodeJson(bytes),{name,generation,max,latest});
    const generationHeader=response.headers.get('x-goog-generation');
    if(generationHeader!==null&&generationHeader!==generation)fail('METADATA_BINDING_INVALID');
    return metadata;
  };
  const getMedia=async(name,generation,expectedHash,max,signal,{latest=false,knownMetadata,unhashed=false}={})=>{
    if(!gen(generation)||(!unhashed&&!hex(expectedHash)))fail('PIN_INVALID');
    const metadata=knownMetadata??await getMetadata(name,generation,max,signal,{latest});
    const url=urlFor(name,generation,{media:true}),response=await send(url,{signal,headers:{Accept:'application/octet-stream','Accept-Encoding':'identity'}});
    responseOk(response,url);mediaHeaders(response,{generation,size:metadata.size,latest});
    const bytes=await boundedBytes(response,max);
    if(bytes.length!==metadata.size||(!unhashed&&await sha256(bytes)!==expectedHash))fail('CONTENT_HASH_MISMATCH');
    return bytes;
  };
  const discoverDaily=async(name,max,signal)=>{
    const url=urlFor(name,undefined,{media:true}),response=await send(url,{method:'HEAD',signal,headers:{'Accept-Encoding':'identity'}});
    responseOk(response,url);
    const generation=response.headers.get('x-goog-generation');if(!gen(generation))fail('GENERATION_INVALID');
    const size=lengthHeader(response,max,{required:true});
    const metadata=await getMetadata(name,generation,max,signal);
    if(size!==metadata.size)fail('LENGTH_MISMATCH');
    const bytes=await getMedia(name,generation,undefined,max,signal,{knownMetadata:metadata,unhashed:true});
    return {bytes,generation,sha256:await sha256(bytes)};
  };
  // This symbol never crosses the public API. Only the create wrapper may
  // admit one preview write after its own authenticated HEAD returned 404.
  const previewAdmission=Symbol('private-preview-create-admission');
  const replacementAdmission=Symbol('private-preview-replacement-admission');
  const writeLatest=async({target,ifGenerationMatch,headers,bytes,metadata,signal,replacement}={},admission)=>{
      sameTarget(target);
      if(ifGenerationMatch!=='0'&&!gen(ifGenerationMatch))fail('CAS_GENERATION_INVALID');
      if(!obj(headers)||Object.keys(headers).sort().join('|')!==Object.keys(LATEST_HEADERS).sort().join('|'))fail('LATEST_HEADERS_INVALID');
      latestHeaders(headers);
      if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_BYTES||!obj(metadata))fail('WRITE_INVALID');
      const display=new Uint8Array(bytes),frozen=structuredClone(metadata),displaySha256=frozen.displaySha256;
      delete frozen.displaySha256;
      const isPreview=frozen.schema===ACCEPTED_PREVIEW_SCHEMA;
      const replacing=isPreview&&ifGenerationMatch!=='0';
      if(replacing&&admission!==replacementAdmission)fail('PREVIEW_CREATE_ONLY');
      if(replacing&&typeof requestPreviewReplacement!=='function')fail('PREVIEW_REPLACEMENT_REQUIRED');
      if(isPreview&&previewWriteStarted)fail('PREVIEW_CREATE_CLOSED');
      if(isPreview&&admission!==(replacing?replacementAdmission:previewAdmission))fail('PREVIEW_CREATE_REQUIRED');
      try{decoder.decode(display);}catch{fail('DISPLAY_UTF8_INVALID');}
      if(!hex(displaySha256)||await sha256(display)!==displaySha256)fail('CONTENT_HASH_MISMATCH');
      const custom=isPreview?previewCustomMetadata(frozen,displaySha256):customMetadata(frozen,displaySha256);
      const resource={name:LATEST_TARGET.object,contentType:LATEST_HEADERS.contentType,
        contentDisposition:LATEST_HEADERS.contentDisposition,cacheControl:LATEST_HEADERS.cacheControl,metadata:custom};
      const resourceBytes=encoder.encode(JSON.stringify(resource));
      if(resourceBytes.length>MAX_METADATA_BYTES)fail('METADATA_SIZE_LIMIT');
      const boundary='xuan_owner_latest_'+displaySha256;
      if(includesBytes(display,encoder.encode('\r\n--'+boundary)))fail('MULTIPART_BOUNDARY_CONFLICT');
      const body=concat(encoder.encode('--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'),resourceBytes,
        encoder.encode('\r\n--'+boundary+'\r\nContent-Type: '+LATEST_HEADERS.contentType+'\r\n\r\n'),display,encoder.encode('\r\n--'+boundary+'--\r\n'));
      const url=new URL(UPLOAD);url.searchParams.set('uploadType','multipart');url.searchParams.set('ifGenerationMatch',ifGenerationMatch);
      if(isPreview){if(previewWriteStarted)fail('PREVIEW_CREATE_CLOSED');previewWriteStarted=true;}
      const options={method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary,Accept:'application/json'},body,signal};
      if(signal?.aborted)fail('ABORTED');
      const response=replacing?await requestPreviewReplacement(url.href,options,structuredClone(replacement)):await send(url.href,options);
      responseOk(response,url.href);
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')||''))fail('METADATA_CONTENT_TYPE');
      const ack=objectMetadata(decodeJson(await boundedBytes(response,MAX_METADATA_BYTES)),{name:LATEST_TARGET.object,max:MAX_BYTES,latest:true});
      if(BigInt(ack.generation)<=BigInt(ifGenerationMatch)||ack.size!==display.length||!obj(ack.metadata)
        ||Object.keys(ack.metadata).sort().join('|')!==Object.keys(custom).sort().join('|')
        ||Object.keys(custom).some(key=>ack.metadata[key]!==custom[key]))fail('WRITE_ACK_UNVERIFIED');
      return {...LATEST_TARGET,generation:ack.generation,size:ack.size};
  };
  const store={
    async probeLatestExists({target,signal}={}){
      sameTarget(target);
      const url=urlFor(LATEST_TARGET.object,undefined,{media:true});
      const response=await send(url,{method:'HEAD',signal,headers:{'Accept-Encoding':'identity'}});
      return {state:responseOk(response,url,{absent:true,presenceOnly:true})?'present':'absent'};
    },
    async createAcceptedPreview(args){
      if(previewCreateClosed)fail('PREVIEW_CREATE_CLOSED');
      previewCreateClosed=true;
      const {target,bytes,metadata,signal}=args??{};
      sameTarget(target);
      if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_BYTES)fail('WRITE_INVALID');
      const display=new Uint8Array(bytes),frozen=structuredClone(metadata);
      validateAcceptedPreviewMetadata(frozen);
      // Even a malformed existing object is a stop: no metadata/media GET and
      // no POST. Only an authenticated fixed-target HEAD 404 permits CAS0.
      if((await store.probeLatestExists({signal})).state!=='absent')fail('LATEST_ALREADY_EXISTS');
      return writeLatest({target:LATEST_TARGET,ifGenerationMatch:'0',headers:LATEST_HEADERS,
        bytes:display,metadata:{...frozen,displaySha256:await sha256(display)},signal},previewAdmission);
    },
    async replaceAcceptedPreview(args){
      if(previewReplacementClosed||previewCreateClosed||previewWriteStarted)fail('PREVIEW_REPLACEMENT_CLOSED');
      previewReplacementClosed=true;
      const {target,previousGeneration,previousDisplaySha256,previousMetadata,revisionSha256,bytes,metadata,signal}=args??{};
      sameTarget(target);
      if(typeof requestPreviewReplacement!=='function'||!gen(previousGeneration)||!hex(previousDisplaySha256)||!hex(revisionSha256)
        ||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_BYTES)fail('PREVIEW_REPLACEMENT_REQUIRED');
      const display=new Uint8Array(bytes),next=structuredClone(metadata),oldMetadata=structuredClone(previousMetadata);
      validateAcceptedPreviewMetadata(next);validateAcceptedPreviewMetadata(oldMetadata);
      const old=await store.readLatest({target:LATEST_TARGET,signal});
      if(old.state!=='present'||old.kind!=='accepted-preview'||old.generation!==previousGeneration
        ||await sha256(old.displayBytes)!==previousDisplaySha256
        ||previewCustomMetadata(old.preview.metadata,previousDisplaySha256).previewMetadata!==previewCustomMetadata(oldMetadata,previousDisplaySha256).previewMetadata)fail('PREVIEW_REPLACEMENT_OLD_CHANGED');
      return writeLatest({target:LATEST_TARGET,ifGenerationMatch:previousGeneration,headers:LATEST_HEADERS,bytes:display,
        metadata:{...next,displaySha256:await sha256(display)},signal,
        replacement:{revisionSha256,previousGeneration,previousDisplaySha256,previousRegistrationSha256:oldMetadata.registrationSha256}},replacementAdmission);
    },
    async readDailyBundle({dataDate,signal}={}){
      exactDate(dataDate);
      const artifactObject=`delivery/${dataDate}/report.html`,receiptObject=`delivery/${dataDate}/receipt.json`;
      // Never infer receipt bytes or pins from the report or an upload ACK.
      const html=await discoverDaily(artifactObject,MAX_BYTES,signal);
      const receipt=await discoverDaily(receiptObject,MAX_RECEIPT_BYTES,signal);
      return {html:html.bytes,receipt:receipt.bytes,artifactObject,artifactGeneration:html.generation,
        artifactSha256:html.sha256,receiptObject,receiptGeneration:receipt.generation,receiptSha256:receipt.sha256};
    },
    async readLatest({target,signal}={}){
      sameTarget(target);
      // HEAD discovers only the fixed pointer. Every object GET is then pinned
      // to this generation; a concurrent CAS cannot change any bytes we read.
      const url=urlFor(LATEST_TARGET.object,undefined,{media:true});
      const response=await send(url,{method:'HEAD',signal,headers:{'Accept-Encoding':'identity'}});
      if(!responseOk(response,url,{absent:true}))return {state:'absent'};
      const generation=response.headers.get('x-goog-generation');
      if(!gen(generation))fail('LATEST_GENERATION_REQUIRED');
      const size=lengthHeader(response,MAX_BYTES,{required:true});
      latestResponseHeaders(response);
      const m=await getMetadata(LATEST_TARGET.object,generation,MAX_BYTES,signal,{latest:true});
      if(m.size!==size)fail('LATEST_SIZE_MISMATCH');
      const custom=parseCustom(m.metadata);
      const displayBytes=await getMedia(LATEST_TARGET.object,generation,custom.displaySha256,MAX_BYTES,signal,{latest:true,knownMetadata:m});
      if(custom.kind==='accepted-preview')return {state:'present',generation,kind:'accepted-preview',
        preview:{metadata:structuredClone(custom.preview)},displayBytes};
      const html=await getMedia(dailyName(custom.bundle.artifactObject,'report.html'),custom.bundle.artifactGeneration,custom.bundle.artifactSha256,MAX_BYTES,signal);
      const receipt=await getMedia(dailyName(custom.bundle.receiptObject,'receipt.json'),custom.bundle.receiptGeneration,custom.bundle.receiptSha256,MAX_RECEIPT_BYTES,signal);
      return {state:'present',generation,bundle:{metadata:structuredClone(custom.bundle),html,receipt},displayBytes};
    },
    async readPinnedSource({name,generation,sha256:expectedHash,signal}={}){
      return getMedia(sourceName(name),generation,expectedHash,MAX_SOURCE_BYTES,signal);
    },
    async readLatestGeneration({target,generation,sha256:expectedHash,metadata,signal}={}){
      sameTarget(target);
      if(!gen(generation)||!hex(expectedHash))fail('PIN_INVALID');
      const expected=metadata===undefined?null:structuredClone(metadata);
      const m=await getMetadata(LATEST_TARGET.object,generation,MAX_BYTES,signal,{latest:true});
      const actual=parseCustom(m.metadata);
      if(actual.displaySha256!==expectedHash)fail('READBACK_METADATA_MISMATCH');
      if(expected!==null){
        if(!obj(expected)||expected.displaySha256!==expectedHash)fail('READBACK_METADATA_MISMATCH');
        delete expected.displaySha256;
        const custom=expected.schema===ACCEPTED_PREVIEW_SCHEMA?previewCustomMetadata(expected,expectedHash):customMetadata(expected,expectedHash);
        if((expected.schema===ACCEPTED_PREVIEW_SCHEMA)!==(actual.kind==='accepted-preview'))fail('READBACK_METADATA_MISMATCH');
        if(Object.keys(custom).some(key=>custom[key]!==m.metadata[key]))fail('READBACK_METADATA_MISMATCH');
      }
      return getMedia(LATEST_TARGET.object,generation,expectedHash,MAX_BYTES,signal,{latest:true,knownMetadata:m});
    },
    async replaceLatest(args){return writeLatest(args);}
  };
  return Object.freeze(store);
}
