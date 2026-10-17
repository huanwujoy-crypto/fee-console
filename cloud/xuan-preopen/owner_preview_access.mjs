// Protected configured-audience check. No SDK, credential, environment, IAM
// mutation or network fallback exists here. Production constructs the fixed
// SDK bridge only after verifying the actual protected checkout.
// Role fingerprints cover storage.* only. This is not an audit of nonstorage
// delegation or deny policies, nor proof that every approved machine uses GET.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
import {LATEST_TARGET,LATEST_HEADERS} from './owner_latest.mjs';
import {requireProtectedOwnerCheckout} from './owner_latest_delivery.mjs';
import {createOwnerSdkTransport} from './owner_sdk_transport.mjs';
export const CANARY_TARGET=Object.freeze({bucket:LATEST_TARGET.bucket,object:'delivery/owner-phone-canary-v1.html'});
export const FULL_PREFLIGHT_TTL_MS=60000,MAX_BOUNDARY_WINDOW_MS=30000,MAX_BOUNDARY_AGE_MS=5000,MAX_CANARY_BYTES=4096;
export const FINANCIAL_ADMISSION_TTL_MS=5000;
const PROJECT='family-portfolio-gateway';
const TARGETS=[LATEST_TARGET.object,CANARY_TARGET.object];
const HEX=/^[a-f0-9]{64}$/,GEN=/^[1-9][0-9]{0,29}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const object=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const fail=code=>{throw Object.assign(Error('OWNER_ACCESS_'+code),{safeCode:'OWNER_ACCESS_'+code});};
const exact=(x,keys)=>{if(!object(x)||Object.keys(x).sort().join('|')!==keys.split(' ').sort().join('|'))fail('SHAPE');};
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const text=x=>JSON.stringify(canonical(x));
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'||x instanceof Uint8Array?x:text(x)).digest('hex');
const instant=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
function strictJson(source){try{parseDecisionJson(source,2000000);return JSON.parse(source);}catch{fail('JSON');}}
const FIXED_APPROVED=Object.freeze(strictJson(fs.readFileSync(new URL('../../security/xuan-owner-approved-audience.json',import.meta.url),'utf8')));
function normalizePolicy(policy,{bucket=false}={}){
  const allowed=bucket?['bindings','etag','version','kind','resourceId']:['bindings','etag','version'];
  if(!object(policy)||Object.keys(policy).some(k=>!allowed.includes(k))||!Array.isArray(policy.bindings)
    ||policy.bindings.length>200||![1,3].includes(policy.version??1))fail('POLICY');
  if(Object.hasOwn(policy,'etag')&&(typeof policy.etag!=='string'||!policy.etag||policy.etag.length>1024||/[\r\n\0]/.test(policy.etag)))fail('POLICY');
  // Native GCS JSON includes these resource representation fields; the CLI
  // projection omits them. They are optional only as a pair, and are accepted
  // solely for this exact bucket. Project policies do not admit either field.
  if(bucket&&(Object.hasOwn(policy,'kind')||Object.hasOwn(policy,'resourceId'))
    &&(policy.kind!=='storage#policy'||policy.resourceId!=='projects/_/buckets/'+LATEST_TARGET.bucket))fail('POLICY_RESOURCE');
  const bindings=policy.bindings.map(binding=>{
    if(!object(binding)||Object.keys(binding).some(k=>!['role','members','condition'].includes(k))||typeof binding.role!=='string'
      ||!Array.isArray(binding.members)||!binding.members.length||binding.members.length>100)fail('BINDING');
    const members=binding.members.map(m=>{
      if(typeof m!=='string'||!m||/[\r\n\0]/.test(m))fail('MEMBER');return m.startsWith('user:')?'user:'+m.slice(5).toLowerCase():m;
    }).sort();if(new Set(members).size!==members.length)fail('MEMBER');
    const row={role:binding.role,members};
    if(Object.hasOwn(binding,'condition')){
      const c=binding.condition;if(!object(c)||Object.keys(c).some(k=>!['title','description','expression'].includes(k))
        ||typeof c.expression!=='string'||Object.values(c).some(v=>typeof v!=='string'))fail('CONDITION');row.condition={...c};
    }return row;
  }).sort((a,b)=>text(a)<text(b)?-1:text(a)>text(b)?1:0);
  // CLI projections may omit version while preserving the full condition.
  // Bind those conditions themselves; represent the same policy semantics.
  return {version:bindings.some(b=>Object.hasOwn(b,'condition'))?3:1,bindings};
}
function normalizeRole(role){
  if(!object(role)||Object.keys(role).some(k=>!['name','includedPermissions','stage','deleted','title','description','etag'].includes(k))
    ||typeof role.name!=='string'||!Array.isArray(role.includedPermissions)||role.includedPermissions.length>20000
    ||role.includedPermissions.some(x=>typeof x!=='string'||x.length>256||!/^[a-zA-Z0-9_./-]+$/.test(x))
    ||new Set(role.includedPermissions).size!==role.includedPermissions.length||role.deleted===true||typeof role.stage!=='string')fail('ROLE');
  return {name:role.name,includedPermissions:[...role.includedPermissions].filter(x=>x.startsWith('storage.')).sort(),stage:role.stage,deleted:role.deleted??false};
}
function normalizedBase(boundary){
  exact(boundary,'schema actorIdentifier bucketMetadata bucketIam projectIam projectMetadata roleDefinitions bucketTestPermissions startedAt completedAt');
  if(!object(boundary.bucketTestPermissions)||!Array.isArray(boundary.bucketTestPermissions.permissions)
    ||!['storage.objects.get','storage.objects.create'].every(p=>boundary.bucketTestPermissions.permissions.includes(p)))fail('TEST_PERMISSIONS');
  if(boundary.schema!=='xuan.owner-sdk-live-boundary.v1'||typeof boundary.actorIdentifier!=='string'||!boundary.actorIdentifier
    ||/[\s\0]/.test(boundary.actorIdentifier))fail('ACTOR');
  const b=boundary.bucketMetadata,p=boundary.projectMetadata;
  if(!object(b)||b.name!==LATEST_TARGET.bucket||!/^\d{6,30}$/.test(String(b.projectNumber))||b.location!=='ASIA-EAST2'
    ||b.storageClass!=='STANDARD'||b.iamConfiguration?.uniformBucketLevelAccess?.enabled!==true
    ||b.iamConfiguration?.publicAccessPrevention!=='enforced'||!object(p)||p.projectId!==PROJECT
    ||String(p.projectNumber)!==String(b.projectNumber)||p.parent!==undefined&&p.parent!==null)fail('PROJECT_OR_BUCKET');
  const bucketMetadata={name:b.name,projectNumberSha256:hash(String(b.projectNumber)),location:b.location,storageClass:b.storageClass,
    uniformBucketLevelAccessEnabled:true,publicAccessPrevention:'enforced'};
  return {actorIdentifierSha256:hash(boundary.actorIdentifier),bucketMetadata,bucketIam:normalizePolicy(boundary.bucketIam,{bucket:true}),
    projectIam:normalizePolicy(boundary.projectIam),projectMetadata:{projectId:PROJECT,projectNumberSha256:hash(String(b.projectNumber)),parent:null}};
}
function readerSets(base,roles,ownerHash){
  const sets=Object.fromEntries(TARGETS.map(t=>[t,new Set()])),owner=Object.fromEntries(TARGETS.map(t=>[t,new Set()]));
  const selectors={projectOwner:'roles/owner',projectEditor:'roles/editor',projectViewer:'roles/viewer'};
  const basic=Object.fromEntries(Object.values(selectors).map(role=>[role,base.projectIam.bindings.filter(b=>b.role===role)]));
  for(const [level,policy] of [['bucket',base.bucketIam],['project',base.projectIam]])for(const binding of policy.bindings){
    const role=roles.get(binding.role);if(!role)fail('ROLE_MISSING');
    const permissions=role.includedPermissions.filter(p=>['storage.objects.get','storage.objects.create','storage.objects.delete'].includes(p));
    if(!permissions.length)continue;
    const members=binding.members.flatMap(m=>{
      const [kind,id]=m.split(':');if(!selectors[kind])return [m];
      if(id!==PROJECT||basic[selectors[kind]].some(b=>b.condition))fail('SELECTOR');return basic[selectors[kind]].flatMap(b=>b.members);
    });
    for(const target of TARGETS){
      const resource='projects/_/buckets/'+LATEST_TARGET.bucket+'/objects/'+target,c=binding.condition;
      if(c){const prefix=c.expression.match(/^resource\.name\.startsWith\('([^']+)'\)$/),exactMatch=c.expression.match(/^resource\.name\s*==\s*'([^']+)'$/);
        if(!prefix&&!exactMatch)fail('CONDITION');if(!(prefix?resource.startsWith(prefix[1]):resource===exactMatch[1]))continue;}
      for(const member of members){
        if(!/^(?:user|serviceAccount):[^\s:]+$/.test(member))fail('UNRESOLVED_PRINCIPAL');
        const digest=hash(member);if(permissions.includes('storage.objects.get'))sets[target].add(digest);
        if(digest===ownerHash)for(const p of permissions)owner[target].add(p);
      }
    }
  }
  for(const target of TARGETS)if(!['storage.objects.get','storage.objects.create'].every(p=>owner[target].has(p)))fail('OWNER_ACCESS');
  return Object.fromEntries(TARGETS.map(t=>[t,[...sets[t]].sort()]));
}
function validApproved(approved){
  exact(approved,'schema project projectNumberSha256 bucket targets actorIdentifierSha256 ownerPrincipalSha256 approvedReaderPrincipalSha256 bucketMetadataSha256 bucketIamSha256 projectIamSha256 projectMetadataSha256 roleDefinitions rolePermissionScope boundarySha256');
  const copy=structuredClone(approved);delete copy.boundarySha256;
  if(approved.rolePermissionScope!=='storage.*'||approved.schema!=='xuan.owner-approved-audience.v1'||approved.project!==PROJECT||!HEX.test(approved.projectNumberSha256)
    ||approved.bucket!==LATEST_TARGET.bucket||text(approved.targets)!==text(TARGETS)||hash(copy)!==approved.boundarySha256
    ||!Array.isArray(approved.approvedReaderPrincipalSha256)||approved.approvedReaderPrincipalSha256.length!==7
    ||new Set(approved.approvedReaderPrincipalSha256).size!==7||approved.approvedReaderPrincipalSha256.some(x=>!HEX.test(x))
    ||!Array.isArray(approved.roleDefinitions)||approved.roleDefinitions.length!==17)fail('APPROVED_BOUNDARY');
  for(const field of ['actorIdentifierSha256','ownerPrincipalSha256','bucketMetadataSha256','bucketIamSha256','projectIamSha256','projectMetadataSha256'])if(!HEX.test(approved[field]))fail('APPROVED_BOUNDARY');
  for(const r of approved.roleDefinitions){exact(r,'name sha256');if(typeof r.name!=='string'||!HEX.test(r.sha256))fail('APPROVED_BOUNDARY');}
}
// A pure descriptor is not a grant or runtime session; used to compare fixture
// semantics without disclosing raw policies in the protected hash registry.
export function describeOwnerBoundary(boundary,{ownerPrincipalSha256,approvedReaderPrincipalSha256}={}){
  const b=normalizedBase(boundary),roleDefinitions=(boundary.roleDefinitions??[]).map(normalizeRole)
    .map(r=>({name:r.name,sha256:hash(r)})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const result={schema:'xuan.owner-approved-audience.v1',project:PROJECT,projectNumberSha256:hash(String(boundary.projectMetadata.projectNumber)),bucket:LATEST_TARGET.bucket,
    targets:[...TARGETS],actorIdentifierSha256:b.actorIdentifierSha256,ownerPrincipalSha256,
    approvedReaderPrincipalSha256:[...approvedReaderPrincipalSha256].sort(),bucketMetadataSha256:hash(b.bucketMetadata),
    bucketIamSha256:hash(b.bucketIam),projectIamSha256:hash(b.projectIam),projectMetadataSha256:hash(b.projectMetadata),
    roleDefinitions,rolePermissionScope:'storage.*'};
  result.boundarySha256=hash(result);return result;
}
// Pure comparison helper for synthetic tests. Its return value is not an access
// capability. Production sessions below always use the fixed protected file.
export function evaluateOwnerBoundary(boundary,approved,{cachedRoles}={}){
  validApproved(approved);const b=normalizedBase(boundary);
  for(const [field,value] of [['actorIdentifierSha256',b.actorIdentifierSha256],['bucketMetadataSha256',hash(b.bucketMetadata)],
    ['bucketIamSha256',hash(b.bucketIam)],['projectIamSha256',hash(b.projectIam)],['projectMetadataSha256',hash(b.projectMetadata)]])
    if(value!==approved[field])fail('BOUNDARY_CHANGED');
  if(!cachedRoles&&(!Array.isArray(boundary.roleDefinitions)||boundary.roleDefinitions.length!==17))fail('ROLE_SET');
  const roles=cachedRoles??new Map(boundary.roleDefinitions.map(r=>{const n=normalizeRole(r);return [n.name,n];}));
  const names=[...new Set([...b.bucketIam.bindings,...b.projectIam.bindings].map(x=>x.role))].sort();
  if(names.length!==17||text(names)!==text(approved.roleDefinitions.map(r=>r.name).sort())||roles.size!==17)fail('ROLE_SET');
  for(const r of approved.roleDefinitions)if(hash(normalizeRole(roles.get(r.name)))!==r.sha256)fail('ROLE_CHANGED');
  const readers=readerSets(b,roles,approved.ownerPrincipalSha256),expected=[...approved.approvedReaderPrincipalSha256].sort();
  if(TARGETS.some(t=>text(readers[t])!==text(expected)))fail('READER_SET');
  return {boundarySha256:approved.boundarySha256,roles,readerCount:expected.length};
}
export function validateOwnerBoundaryWindow(boundary,now){
  if(!instant(boundary.startedAt)||!instant(boundary.completedAt)||!Number.isFinite(now))fail('CLOCK');
  const start=Date.parse(boundary.startedAt),end=Date.parse(boundary.completedAt);
  if(start>end||end>now||end-start>MAX_BOUNDARY_WINDOW_MS||now-end>MAX_BOUNDARY_AGE_MS)fail('STALE_BOUNDARY');
}
export function validateOwnerPreflightAge(checkedAt,now){
  if(!Number.isFinite(checkedAt)||!Number.isFinite(now)||now<checkedAt||now-checkedAt>FULL_PREFLIGHT_TTL_MS)fail('PREFLIGHT_EXPIRED');
}
// Pure cache state, not an access capability. Production creates its own lease
// and never accepts one from the caller. Failed refreshes leave it invalid.
export function createOwnerPreflightLease(){
  let checked=null,checkedAt=null,admissionUntil=null;
  const current=now=>{if(!checked)fail('PREFLIGHT_EXPIRED');validateOwnerPreflightAge(checkedAt,now);return checked;};
  return Object.freeze({
    invalidate(){checked=null;checkedAt=null;admissionUntil=null;},
    install(result,at){if(!object(result)||!(result.roles instanceof Map)||!Number.isFinite(at))fail('PREFLIGHT_STATE');checked=result;checkedAt=at;admissionUntil=null;},
    current,
    clearAdmission(){admissionUntil=null;},
    mintAdmission(now){current(now);admissionUntil=now+FINANCIAL_ADMISSION_TTL_MS;},
    consumeAdmission(now){const end=admissionUntil;admissionUntil=null;current(now);
      if(end===null||now>end||now<end-FINANCIAL_ADMISSION_TTL_MS)fail('FINANCIAL_ADMISSION_REQUIRED');},
  });
}

export function renderOwnerPhoneCanary({uuid,createdAt,candidateSha256}={}){
  if(!UUID.test(uuid||'')||!instant(createdAt)||!HEX.test(candidateSha256||''))fail('CANARY_FIELDS');
  return encoder.encode('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Private delivery check</title></head><body><!-- xuan.owner-phone-canary.v1 --><h1>Private delivery check</h1><p>Reference: '+uuid+'</p><p>Created at UTC: '+createdAt+'</p><p>Candidate SHA-256: '+candidateSha256+'</p></body></html>');
}
export function validateOwnerPhoneCanary(bytes,fields){
  if(!(bytes instanceof Uint8Array)||bytes.length>MAX_CANARY_BYTES||!bytes.length)fail('CANARY_BYTES');
  const expected=renderOwnerPhoneCanary(fields);if(bytes.length!==expected.length||hash(bytes)!==hash(expected))fail('CANARY_BYTES');return hash(bytes);
}
const canaryUrl=(generation,media=false)=>{
  const u=new URL('https://storage.googleapis.com/storage/v1/b/'+CANARY_TARGET.bucket+'/o/'+encodeURIComponent(CANARY_TARGET.object));
  if(generation!==undefined){if(!GEN.test(generation))fail('CANARY_GENERATION');u.searchParams.set('generation',generation);}if(media)u.searchParams.set('alt','media');return u.href;
};
function response(response,url,{missing=false}={}){
  if(!(response instanceof Response)||response.redirected||response.url&&response.url!==url)fail('CANARY_RESPONSE');
  if(missing&&response.status===404)return false;
  if(response.status!==200){const e=Object.assign(Error('OWNER_ACCESS_CANARY_HTTP'),{safeCode:'OWNER_ACCESS_CANARY_HTTP',status:response.status});throw e;}return true;
}
async function bounded(response,limit){
  if(response.headers.get('content-encoding')&&!/^identity$/i.test(response.headers.get('content-encoding')))fail('CANARY_ENCODING');
  const length=response.headers.get('content-length');if(length!==null&&(!/^[1-9][0-9]*$/.test(length)||Number(length)>limit))fail('CANARY_SIZE');
  const reader=response.body?.getReader();if(!reader)fail('CANARY_BODY');const chunks=[];let count=0;
  try{for(;;){const r=await reader.read();if(r.done)break;if(!(r.value instanceof Uint8Array)||(count+=r.value.length)>limit){reader.cancel().catch(()=>{});fail('CANARY_SIZE');}chunks.push(new Uint8Array(r.value));}}finally{reader.releaseLock();}
  if(!count||length!==null&&Number(length)!==count)fail('CANARY_SIZE');return new Uint8Array(Buffer.concat(chunks.map(c=>Buffer.from(c))));
}
async function readCanary(requestCanary,pin,signal){
  exact(pin,'uuid createdAt candidateSha256 generation sha256');if(!GEN.test(pin.generation)||!HEX.test(pin.sha256))fail('CANARY_PIN');
  const url=canaryUrl(pin.generation),r=await requestCanary({method:'GET',generation:pin.generation,media:false,signal});response(r,url);
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(r.headers.get('content-type')||''))fail('CANARY_METADATA_TYPE');
  if(r.headers.has('x-goog-generation')&&r.headers.get('x-goog-generation')!==pin.generation)fail('CANARY_METADATA');
  const m=strictJson(decoder.decode(await bounded(r,16000)));
  validateOwnerCanaryMetadata(m,pin);
  const media=canaryUrl(pin.generation,true),raw=await requestCanary({method:'GET',generation:pin.generation,media:true,signal});response(raw,media);
  if(raw.headers.get('x-goog-generation')!==pin.generation||raw.headers.get('content-length')!==String(m.size)
    ||raw.headers.get('content-type')!==LATEST_HEADERS.contentType||raw.headers.get('content-disposition')!==LATEST_HEADERS.contentDisposition
    ||raw.headers.get('cache-control')!==LATEST_HEADERS.cacheControl)fail('CANARY_MEDIA');
  const bytes=await bounded(raw,MAX_CANARY_BYTES);if(bytes.length!==Number(m.size)||validateOwnerPhoneCanary(bytes,pin)!==pin.sha256)fail('CANARY_HASH');return pin;
}
export function validateOwnerCanaryMetadata(m,pin){
  exact(pin,'uuid createdAt candidateSha256 generation sha256');renderOwnerPhoneCanary(pin);
  const expectedMeta={schema:'xuan.owner-phone-canary.v1',uuid:pin.uuid,createdAt:pin.createdAt,candidateSha256:pin.candidateSha256,canarySha256:pin.sha256};
  if(!GEN.test(pin.generation)||!HEX.test(pin.sha256)||!object(m)||m.bucket!==CANARY_TARGET.bucket||m.name!==CANARY_TARGET.object
    ||m.generation!==pin.generation||typeof m.size!=='string'||!/^[1-9][0-9]{0,4}$/.test(m.size)||Number(m.size)>MAX_CANARY_BYTES
    ||m.contentType!==LATEST_HEADERS.contentType||m.contentDisposition!==LATEST_HEADERS.contentDisposition||m.cacheControl!==LATEST_HEADERS.cacheControl
    ||text(m.metadata)!==text(expectedMeta))fail('CANARY_METADATA');
}

// Production has no SDK/audience/clock/proof override. Protected checkout is
// checked before constructing the real SDK bridge or performing live SDK I/O.
export async function createOwnerPreviewAccess(){
  await requireProtectedOwnerCheckout();
  validApproved(FIXED_APPROVED);
  const registration=strictJson(fs.readFileSync(new URL('../../security/xuan-owner-accepted-preview.json',import.meta.url),'utf8'));
  const candidateSha256=registration.displaySha256;if(!HEX.test(candidateSha256||''))fail('REGISTERED_CANDIDATE');
  const sdk=createOwnerSdkTransport();
  if(!sdk||typeof sdk.readLiveBoundary!=='function'||typeof sdk.request!=='function'
    ||typeof sdk.requestCanary!=='function'||typeof sdk.createCanary!=='function'||typeof sdk.close!=='function')fail('SDK_CAPABILITIES');
  let canaryClosed=false,canaryPin=null,sessionClosed=false;const lease=createOwnerPreflightLease();
  const guard=()=>{if(sessionClosed)fail('SESSION_CLOSED');};
  const full=async()=>{
    guard();lease.invalidate();
    const start=Date.now(),boundary=await sdk.readLiveBoundary({includeRoleDefinitions:true});validateOwnerBoundaryWindow(boundary,Date.now());
    const next=evaluateOwnerBoundary(boundary,FIXED_APPROVED),end=Date.now();
    if(end<start||end-start>MAX_BOUNDARY_WINDOW_MS)fail('PREFLIGHT_CLOCK');guard();lease.install(next,end);
    return {boundarySha256:next.boundarySha256,rolePermissionScope:'storage.*',roleDefinitionsChecked:17,readerCount:7,
      expiresAt:new Date(end+FULL_PREFLIGHT_TTL_MS).toISOString()};
  };
  const live=async signal=>{
    guard();lease.current(Date.now());
    const quick=await sdk.readLiveBoundary({includeRoleDefinitions:false,signal});validateOwnerBoundaryWindow(quick,Date.now());
    evaluateOwnerBoundary(quick,FIXED_APPROVED,{cachedRoles:lease.current(Date.now()).roles});
    guard();lease.current(Date.now());
  };
  try{await full();}catch(error){sdk.close();throw error;}
  return Object.freeze({
    request:(url,options={})=>{
      guard();if((options.method??'GET')==='POST'){
        lease.consumeAdmission(Date.now()); // Every possible write consumes admission.
        if(options.signal?.aborted||!canaryPin)fail('FINANCIAL_ADMISSION_REQUIRED');
      }return sdk.request(url,options);
    },
    // Refresh is explicit, before the financial publisher's ten-second window.
    // It changes neither identity nor permissions and never refreshes tokens.
    async refreshPreflight(){guard();lease.invalidate();await requireProtectedOwnerCheckout();return full();},
    async verifyDestinationAccess({target,operation,signal}={}){
      lease.clearAdmission();
      if(!object(target)||Object.keys(target).sort().join('|')!=='bucket|object'||target.bucket!==LATEST_TARGET.bucket
        ||target.object!==LATEST_TARGET.object||operation!=='create-accepted-preview'||!canaryPin)fail('CANARY_REQUIRED');
      await live(signal);await readCanary(sdk.requestCanary,canaryPin,signal);
      guard();lease.current(Date.now());if(signal?.aborted)fail('ABORTED');
      if(canaryPin.candidateSha256!==candidateSha256)fail('REGISTERED_CANDIDATE');
      lease.mintAdmission(Date.now());
    },
    async createCanary(){
      guard();if(canaryClosed)fail('CANARY_CLOSED');canaryClosed=true;
      let writing=false;const signal=AbortSignal.timeout(30000);
      try{
        // The first write independently checks actual protected source before
        // its live identity/policy read; no caller can assert this approval.
        await requireProtectedOwnerCheckout();await live(signal);
        const url=canaryUrl(undefined,true),head=await sdk.requestCanary({method:'HEAD',media:true,signal});
        if(response(head,url,{missing:true}))fail('CANARY_EXISTS');
        await live(signal);
        const fields={uuid:crypto.randomUUID(),createdAt:new Date().toISOString(),candidateSha256};
        const bytes=renderOwnerPhoneCanary(fields),sha256=hash(bytes),custom={schema:'xuan.owner-phone-canary.v1',...fields,canarySha256:sha256};
        if(signal.aborted)fail('ABORTED');writing=true;
        // The bridge reconstructs exactly the fixed nonfinancial document and
        // metadata. It does not accept arbitrary HTML, metadata or a CAS value.
        const ack=await sdk.createCanary({...fields,signal});
        const upload='https://storage.googleapis.com/upload/storage/v1/b/'+CANARY_TARGET.bucket+'/o?uploadType=multipart&ifGenerationMatch=0';response(ack,upload);
        if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(ack.headers.get('content-type')||''))fail('CANARY_METADATA_TYPE');
        const m=strictJson(decoder.decode(await bounded(ack,16000)));
        if(m.bucket!==CANARY_TARGET.bucket||m.name!==CANARY_TARGET.object||!GEN.test(m.generation)||String(m.size)!==String(bytes.length)
          ||m.contentType!==LATEST_HEADERS.contentType||m.contentDisposition!==LATEST_HEADERS.contentDisposition
          ||m.cacheControl!==LATEST_HEADERS.cacheControl||text(m.metadata)!==text(custom))fail('CANARY_ACK');
        const pin={...fields,generation:m.generation,sha256};await readCanary(sdk.requestCanary,pin,signal);
        guard();lease.current(Date.now());if(signal.aborted)fail('ABORTED');
        canaryPin=Object.freeze(pin);
        return {status:'published-verified',code:'CANARY_PINNED_READBACK_VERIFIED',pin:structuredClone(pin)};
      }catch(error){return {status:writing&&error?.status===412?'conflict':writing?'unknown':'blocked',
        code:writing&&error?.status===412?'CANARY_CAS_CONFLICT_NO_RETRY':writing?'CANARY_WRITE_OUTCOME_UNKNOWN':
          error?.safeCode==='OWNER_ACCESS_CANARY_EXISTS'?'CANARY_EXISTS':'CANARY_ACCESS_OR_VALIDATION_FAILED'};}
    },
    close(){sessionClosed=true;lease.invalidate();sdk.close();},
  });
}
