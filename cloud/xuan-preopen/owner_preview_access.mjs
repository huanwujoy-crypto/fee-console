// Protected configured-audience check. No SDK, credential, environment, IAM
// mutation or network fallback exists here. Production constructs the fixed
// SDK bridge only after verifying the actual protected checkout.
// Role fingerprints cover storage.* only. This is not an audit of nonstorage
// delegation or deny policies, nor proof that every approved machine uses GET.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {types as utilTypes} from 'node:util';
import {safeErrorOrigin} from './report.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
import {LATEST_TARGET,LATEST_HEADERS,ownerJsonMediaHeadersMatch} from './owner_latest.mjs';
import {requireProtectedOwnerCheckout} from './owner_latest_delivery.mjs';
import {createOwnerSdkTransport,decodeOwnerSafeDiagnostics,OWNER_SAFE_ERROR_CODES} from './owner_sdk_transport.mjs';
import {validatePreviewReplacementRegistration,previewReplacementRegistrationText,acceptedPreviewRegistrationText} from './owner_accepted_preview.mjs';
export const CANARY_TARGET=Object.freeze({bucket:LATEST_TARGET.bucket,object:'delivery/owner-phone-canary-v1.html'});
export const FULL_PREFLIGHT_TTL_MS=60000,MAX_BOUNDARY_WINDOW_MS=30000,MAX_BOUNDARY_AGE_MS=5000,MAX_CANARY_BYTES=4096;
export const FINANCIAL_ADMISSION_TTL_MS=5000;
const PROJECT='family-portfolio-gateway';
const TARGETS=[LATEST_TARGET.object,CANARY_TARGET.object];
const HEX=/^[a-f0-9]{64}$/,GEN=/^[1-9][0-9]{0,29}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const object=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const fail=code=>{throw Object.assign(Error('OWNER_ACCESS_'+code),{safeCode:'OWNER_ACCESS_'+code});};
// Only finite own-data diagnostics survive a caught SDK failure. Cleanup never
// changes the primary canary failure or grants an admission capability.
const ACCESS_FAILURE_CODES=new Set(["ABORTED","ACTOR","APPROVED_BOUNDARY","BINDING","BOUNDARY_CHANGED","CANARY_ACK","CANARY_BODY","CANARY_BYTES","CANARY_CLOSED","CANARY_CURRENT","CANARY_ENCODING","CANARY_EXISTS","CANARY_FIELDS","CANARY_GENERATION","CANARY_HASH","CANARY_MEDIA","CANARY_METADATA","CANARY_METADATA_TYPE","CANARY_PIN","CANARY_REQUIRED","CANARY_RESPONSE","CANARY_SIZE","CLOCK","CONDITION","FINANCIAL_ADMISSION_REQUIRED","JSON","MEMBER","OBSERVATION_CLOCK","OBSERVATION_CLOSED","OBSERVATION_CONTEXT","OBSERVATION_REQUIRED","OWNER_ACCESS","POLICY","POLICY_RESOURCE","PREFLIGHT_CLOCK","PREFLIGHT_EXPIRED","PREFLIGHT_STATE","PROJECT_OR_BUCKET","READER_SET","REGISTERED_CANARY","REGISTERED_CANARY_READ","REGISTERED_CANDIDATE","REPLACEMENT_ADMISSION_CLOSED","REPLACEMENT_ADMISSION_EXPIRED","REPLACEMENT_ADMISSION_REQUIRED","REPLACEMENT_BINDING","REPLACEMENT_BYTES","REPLACEMENT_DELETE_PERMISSION","REPLACEMENT_EXISTING_CANARY_ONLY","REPLACEMENT_NAMED_WRITE_REQUIRED","REPLACEMENT_OWNER_DELETE_PERMISSION","REPLACEMENT_REQUIRED","ROLE","ROLE_CHANGED","ROLE_MISSING","ROLE_SET","SDK_CAPABILITIES","SELECTOR","SESSION_CLOSED","SHAPE","STALE_BOUNDARY","STORAGE_ACCESS_ARGUMENTS_FORBIDDEN","TEST_PERMISSIONS","UNRESOLVED_PRINCIPAL","VISUAL_OBSERVATION_NOT_AVAILABLE"].map(code=>'OWNER_ACCESS_'+code));
const diagnosticOwn=(value,key)=>{try{if(!value||!['object','function'].includes(typeof value)||utilTypes.isProxy(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}};
function diagnosticList(value,decode){
  if(utilTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>1)return [];
  const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).some(k=>k!=='length'&&k!=='0'))return [];
  if(!value.length)return [];const item=descriptors['0'];if(!item||!Object.hasOwn(item,'value'))return [];
  const decoded=decode(item.value);return decoded?[decoded]:[];
}
function diagnosticOrigin(error){
  if(!error||!['object','function'].includes(typeof error)||utilTypes.isProxy(error))return safeErrorOrigin(null);
  const own=Object.getOwnPropertyDescriptor(error,'safeOrigin');if(!own)return safeErrorOrigin(error);
  const value=Object.hasOwn(own,'value')?own.value:null,keys=['type','code','causeCode','httpStatus'];
  if(!value||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return safeErrorOrigin(null);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==4||keys.some(k=>!Object.hasOwn(descriptors,k)||!Object.hasOwn(descriptors[k],'value')))return safeErrorOrigin(null);
  const fields=Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
  if(['type','code','causeCode'].some(k=>fields[k]!==null&&typeof fields[k]!=='string')||fields.httpStatus!==null&&typeof fields.httpStatus!=='number')return safeErrorOrigin(null);
  const normalized=safeErrorOrigin({name:fields.type,code:fields.code,cause:{code:fields.causeCode}},fields.httpStatus);
  return keys.every(k=>normalized[k]===fields[k])?normalized:safeErrorOrigin(null);
}
function failureDiagnostics(error){
  const primary=decodeOwnerSafeDiagnostics(diagnosticOwn(error,'ownerSafeDiagnostics'));
  const cleanup=diagnosticList(diagnosticOwn(error,'ownerSafeCleanupDiagnostics'),value=>{const d=decodeOwnerSafeDiagnostics(value);return d?.stage==='close'?d:null;});
  const local=diagnosticList(diagnosticOwn(error,'ownerSafeLocalCleanupCodes'),value=>value==='SDK_LOCAL_CLOSE_FAILED'?value:null);
  return {primary,cleanup,local,origin:diagnosticOrigin(error)};
}
function attachFailureDiagnostics(value,first,closeError){
  if(!value||!['object','function'].includes(typeof value)||utilTypes.isProxy(value))return value;
  const cleanup=[...first.cleanup],local=[...first.local];
  if(closeError!==undefined){const next=failureDiagnostics(closeError);if(!cleanup.length){if(next.primary?.stage==='close')cleanup.push(next.primary);else cleanup.push(...next.cleanup);}if(!local.length)local.push(...next.local);if(!local.length&&diagnosticOwn(closeError,'safeCode')==='SDK_LOCAL_CLOSE_FAILED')local.push('SDK_LOCAL_CLOSE_FAILED');}
  const fields={safeOrigin:first.origin,ownerSafeDiagnostics:first.primary,ownerSafeCleanupDiagnostics:Object.freeze(cleanup),ownerSafeLocalCleanupCodes:Object.freeze(local)};
  for(const [key,item]of Object.entries(fields))try{Object.defineProperty(value,key,{value:item,enumerable:false,writable:false,configurable:false});}catch{}
  return value;
}
function preserveCloseFailure(error,closeError){
  if(diagnosticOwn(closeError,'safeCode')!=='SDK_LOCAL_CLOSE_FAILED'||!error||!['object','function'].includes(typeof error)||utilTypes.isProxy(error))return;
  const prior=diagnosticOwn(error,'safeSecondaryCodes'),codes=[];
  if(prior!==undefined){
    if(utilTypes.isProxy(prior)||!Array.isArray(prior)||Object.getPrototypeOf(prior)!==Array.prototype||prior.length>3)return;
    const descriptors=Object.getOwnPropertyDescriptors(prior);
    if(Reflect.ownKeys(descriptors).some(k=>k!=='length'&&(typeof k!=='string'||!/^[0-2]$/.test(k))))return;
    for(let i=0;i<prior.length;i++){const d=descriptors[i];if(!d||!Object.hasOwn(d,'value')||!['ACCESS_CLOSE_FAILED','TTY_CLEANUP_FAILED','PIPE_CLOSE_UNKNOWN','CANCELLATION_DISPOSE_FAILED','SDK_LOCAL_CLOSE_FAILED'].includes(d.value))return;codes.push(d.value);}
  }else if(error&&Object.getOwnPropertyDescriptor(error,'safeSecondaryCodes'))return;
  if(!codes.includes('SDK_LOCAL_CLOSE_FAILED')&&codes.length<3)codes.push('SDK_LOCAL_CLOSE_FAILED');
  try{Object.defineProperty(error,'safeSecondaryCodes',{value:Object.freeze(codes),enumerable:false,writable:false,configurable:false});}catch{}
}
const canaryFailureReason=error=>{const code=diagnosticOwn(error,'safeCode');return typeof code==='string'&&(ACCESS_FAILURE_CODES.has(code)||OWNER_SAFE_ERROR_CODES.includes(code)||['REPORT_SOURCE_NETWORK_FAILED','REPORT_SOURCE_HTTP','REPORT_SOURCE_JSON_INVALID'].includes(code))?code:'CANARY_VALIDATION_FAILED';};
const exact=(x,keys)=>{if(!object(x)||Object.keys(x).sort().join('|')!==keys.split(' ').sort().join('|'))fail('SHAPE');};
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const text=x=>JSON.stringify(canonical(x));
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'||x instanceof Uint8Array?x:text(x)).digest('hex');
const instant=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
function strictJson(source){try{parseDecisionJson(source,2000000);return JSON.parse(source);}catch{fail('JSON');}}
const FIXED_APPROVED=Object.freeze(strictJson(fs.readFileSync(new URL('../../security/xuan-owner-approved-audience.json',import.meta.url),'utf8')));
const FIXED_REGISTERED_CANARY=Object.freeze(strictJson(fs.readFileSync(new URL('../../security/xuan-owner-registered-canary.json',import.meta.url),'utf8')));
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
function normalizedBase(boundary,{requireDeletePermission=false}={}){
  exact(boundary,'schema actorIdentifier bucketMetadata bucketIam projectIam projectMetadata roleDefinitions bucketTestPermissions startedAt completedAt');
  if(!object(boundary.bucketTestPermissions)||!Array.isArray(boundary.bucketTestPermissions.permissions)
    ||!['storage.objects.get','storage.objects.create'].every(p=>boundary.bucketTestPermissions.permissions.includes(p)))fail('TEST_PERMISSIONS');
  if(requireDeletePermission&&!boundary.bucketTestPermissions.permissions.includes('storage.objects.delete'))fail('REPLACEMENT_DELETE_PERMISSION');
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
function readerSets(base,roles,ownerHash,{requireDeletePermission=false}={}){
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
  if(requireDeletePermission&&!owner[LATEST_TARGET.object].has('storage.objects.delete'))fail('REPLACEMENT_OWNER_DELETE_PERMISSION');
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
export function evaluateOwnerBoundary(boundary,approved,{cachedRoles,requireDeletePermission=false}={}){
  validApproved(approved);const b=normalizedBase(boundary,{requireDeletePermission});
  for(const [field,value] of [['actorIdentifierSha256',b.actorIdentifierSha256],['bucketMetadataSha256',hash(b.bucketMetadata)],
    ['bucketIamSha256',hash(b.bucketIam)],['projectIamSha256',hash(b.projectIam)],['projectMetadataSha256',hash(b.projectMetadata)]])
    if(value!==approved[field])fail('BOUNDARY_CHANGED');
  if(!cachedRoles&&(!Array.isArray(boundary.roleDefinitions)||boundary.roleDefinitions.length!==17))fail('ROLE_SET');
  const roles=cachedRoles??new Map(boundary.roleDefinitions.map(r=>{const n=normalizeRole(r);return [n.name,n];}));
  const names=[...new Set([...b.bucketIam.bindings,...b.projectIam.bindings].map(x=>x.role))].sort();
  if(names.length!==17||text(names)!==text(approved.roleDefinitions.map(r=>r.name).sort())||roles.size!==17)fail('ROLE_SET');
  for(const r of approved.roleDefinitions)if(hash(normalizeRole(roles.get(r.name)))!==r.sha256)fail('ROLE_CHANGED');
  const readers=readerSets(b,roles,approved.ownerPrincipalSha256,{requireDeletePermission}),expected=[...approved.approvedReaderPrincipalSha256].sort();
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
    ||!ownerJsonMediaHeadersMatch({contentType:raw.headers.get('content-type'),contentDisposition:raw.headers.get('content-disposition'),
      cacheControl:raw.headers.get('cache-control')}))fail('CANARY_MEDIA');
  const bytes=await bounded(raw,MAX_CANARY_BYTES);if(bytes.length!==Number(m.size)||validateOwnerPhoneCanary(bytes,pin)!==pin.sha256)fail('CANARY_HASH');
  // The browser entry is unversioned. Reading an older immutable generation is
  // insufficient if another object now occupies that entry. Check it last.
  const current=canaryUrl(undefined,true),head=await requestCanary({method:'HEAD',media:true,signal});response(head,current);
  if(head.headers.get('x-goog-generation')!==pin.generation||head.headers.get('content-length')!==String(m.size)
    ||head.headers.get('content-encoding')&&!/^identity$/i.test(head.headers.get('content-encoding'))
    ||!ownerJsonMediaHeadersMatch({contentType:head.headers.get('content-type'),contentDisposition:head.headers.get('content-disposition'),
      cacheControl:head.headers.get('cache-control')}))fail('CANARY_CURRENT');
  return pin;
}
export function validateRegisteredOwnerCanary(registration,candidateSha256){
  exact(registration,'schema target pin');exact(registration.target,'bucket object');
  const pin=registration.pin;exact(pin,'uuid createdAt candidateSha256 generation sha256');
  if(registration.schema!=='xuan.owner-registered-canary.v1'||registration.target.bucket!==CANARY_TARGET.bucket
    ||registration.target.object!==CANARY_TARGET.object||typeof candidateSha256!=='string'||!HEX.test(candidateSha256)||pin.candidateSha256!==candidateSha256
    ||typeof pin.generation!=='string'||!GEN.test(pin.generation)||typeof pin.sha256!=='string'||!HEX.test(pin.sha256)
    ||hash(renderOwnerPhoneCanary(pin))!==pin.sha256)fail('REGISTERED_CANARY');
  return structuredClone(pin);
}
// Pure, read-only verifier for synthetic tests. A returned descriptor is not a
// publication capability: only the fixed protected production session below
// can install its private pin after fresh actor/IAM and actual SDK reads.
export async function readRegisteredOwnerCanary({requestCanary,registration,candidateSha256,signal}={}){
  const pin=validateRegisteredOwnerCanary(registration,candidateSha256);
  if(typeof requestCanary!=='function'||signal?.aborted)fail('REGISTERED_CANARY_READ');
  await readCanary(requestCanary,pin,signal);
  if(signal?.aborted)fail('ABORTED');return pin;
}
export function validateOwnerCanaryMetadata(m,pin){
  exact(pin,'uuid createdAt candidateSha256 generation sha256');renderOwnerPhoneCanary(pin);
  const expectedMeta={schema:'xuan.owner-phone-canary.v1',uuid:pin.uuid,createdAt:pin.createdAt,candidateSha256:pin.candidateSha256,canarySha256:pin.sha256};
  if(!GEN.test(pin.generation)||!HEX.test(pin.sha256)||!object(m)||m.bucket!==CANARY_TARGET.bucket||m.name!==CANARY_TARGET.object
    ||m.generation!==pin.generation||typeof m.size!=='string'||!/^[1-9][0-9]{0,4}$/.test(m.size)||Number(m.size)>MAX_CANARY_BYTES
    ||m.contentType!==LATEST_HEADERS.contentType||m.contentDisposition!==LATEST_HEADERS.contentDisposition||m.cacheControl!==LATEST_HEADERS.cacheControl
    ||text(m.metadata)!==text(expectedMeta))fail('CANARY_METADATA');
}

// Anti-replay state for an explicit trusted executor/human native-browser
// observation. The nonce is not present in the immutable canary HTML: this is
// an attestation boundary, not cryptographic proof of browser navigation.
// This pure helper alone is never an IAM or publication capability.
export function createReplacementObservation({revisionSha256,candidateSha256,pin,now=Date.now,randomUUID=crypto.randomUUID}={}){
  if(!HEX.test(revisionSha256||'')||!HEX.test(candidateSha256||'')||typeof now!=='function'||typeof randomUUID!=='function')fail('OBSERVATION_CONTEXT');
  const old=structuredClone(pin);renderOwnerPhoneCanary(old);if(!GEN.test(old.generation)||!HEX.test(old.sha256))fail('OBSERVATION_CONTEXT');
  let challenge=null,attested=false,closed=false;
  const invalidate=()=>{challenge=null;attested=false;};
  return Object.freeze({
    begin(){if(closed||challenge)fail('OBSERVATION_CLOSED');const issuedAt=now(),nonce=randomUUID();
      if(!Number.isFinite(issuedAt)||!UUID.test(nonce))fail('OBSERVATION_CLOCK');
      challenge={nonce,issuedAt,expiresAt:issuedAt+60000};
      return {schema:'xuan.owner-native-observation-request.v1',revisionSha256,candidateSha256,oldCanaryPin:structuredClone(old),...challenge};},
    attest(value){
      try{exact(value,'nonce observedAt uuid createdAt candidateSha256');const time=now();
        if(closed||!challenge||attested||value.nonce!==challenge.nonce||!instant(value.observedAt)||!Number.isFinite(time)
          ||time<challenge.issuedAt||time>challenge.expiresAt||Date.parse(value.observedAt)<challenge.issuedAt||Date.parse(value.observedAt)>time
          ||value.uuid!==old.uuid||value.createdAt!==old.createdAt||value.candidateSha256!==old.candidateSha256)fail('OBSERVATION_REQUIRED');
        attested=true;return {status:'trusted-native-ui-attested',revisionSha256,candidateSha256};
      }catch(error){closed=true;invalidate();throw error;}
    },
    consume(){const time=now(),valid=!closed&&attested&&challenge&&Number.isFinite(time)&&time>=challenge.issuedAt&&time<=challenge.expiresAt;
      closed=true;invalidate();if(!valid)fail('OBSERVATION_REQUIRED');},
    close(){closed=true;invalidate();},
  });
}

// Production has no SDK/audience/clock/proof override. Protected checkout is
// checked before constructing the real SDK bridge or performing live SDK I/O.
export async function createOwnerPreviewAccess(){return createPreviewAccessSession(false);}
export async function createOwnerPreviewReplacementAccess(){return createPreviewAccessSession(true);}
// Explicit sensitive storage-only policy. Still the same Mac SDK/owner;
// browser acceptance is independent and cannot be asserted by this capability.
export async function createOwnerPreviewReplacementStorageAccess(){
  if(arguments.length)fail('STORAGE_ACCESS_ARGUMENTS_FORBIDDEN');
  return createPreviewAccessSession(true,true);
}
async function createPreviewAccessSession(replacing,storageOnly=false){
  await requireProtectedOwnerCheckout();
  validApproved(FIXED_APPROVED);
  const registration=strictJson(fs.readFileSync(new URL('../../security/xuan-owner-accepted-preview.json',import.meta.url),'utf8'));
  let revision=null,revisionSha256=null;
  if(replacing){const revisionText=fs.readFileSync(new URL('../../security/xuan-owner-preview-replacement.json',import.meta.url),'utf8');
    revision=validatePreviewReplacementRegistration(strictJson(revisionText),{previousRegistration:registration,previousRegistrationSha256:hash(acceptedPreviewRegistrationText(registration)),
      canaryRegistrationSha256:hash(fs.readFileSync(new URL('../../security/xuan-owner-registered-canary.json',import.meta.url)))});
    if(previewReplacementRegistrationText(revision)!==revisionText)fail('REPLACEMENT_BYTES');revisionSha256=hash(revisionText);
  }
  const candidateSha256=replacing?revision.registration.displaySha256:registration.displaySha256;
  if(!HEX.test(candidateSha256||''))fail('REGISTERED_CANDIDATE');
  const canaryCandidateSha256=registration.displaySha256;
  validateRegisteredOwnerCanary(FIXED_REGISTERED_CANARY,canaryCandidateSha256);
  const sdk=createOwnerSdkTransport();
  if(!sdk||typeof sdk.readLiveBoundary!=='function'||typeof sdk.request!=='function'
    ||typeof sdk.requestCanary!=='function'||typeof sdk.createCanary!=='function'||typeof sdk.close!=='function')fail('SDK_CAPABILITIES');
  let canaryClosed=false,canaryPin=null,sessionClosed=false,observation=null,replacementAdmissionAttempted=false,replacementPermit=null,replacementExpiresAt=null,replacementMonotonic=null;const lease=createOwnerPreflightLease();
  const guard=()=>{if(sessionClosed)fail('SESSION_CLOSED');};
  const close=()=>{sessionClosed=true;lease.invalidate();replacementPermit=null;observation?.close();sdk.close();};
  const full=async()=>{
    guard();lease.invalidate();
    const start=Date.now(),boundary=await sdk.readLiveBoundary({includeRoleDefinitions:true,...(replacing?{requireDeletePermission:true}:{})});validateOwnerBoundaryWindow(boundary,Date.now());
    const next=evaluateOwnerBoundary(boundary,FIXED_APPROVED,{requireDeletePermission:replacing}),end=Date.now();
    if(end<start||end-start>MAX_BOUNDARY_WINDOW_MS)fail('PREFLIGHT_CLOCK');guard();lease.install(next,end);
    return {boundarySha256:next.boundarySha256,rolePermissionScope:'storage.*',roleDefinitionsChecked:17,readerCount:7,
      expiresAt:new Date(end+FULL_PREFLIGHT_TTL_MS).toISOString()};
  };
  const live=async signal=>{
    guard();lease.current(Date.now());
    const quick=await sdk.readLiveBoundary({includeRoleDefinitions:false,signal,...(replacing?{requireDeletePermission:true}:{})});validateOwnerBoundaryWindow(quick,Date.now());
    evaluateOwnerBoundary(quick,FIXED_APPROVED,{cachedRoles:lease.current(Date.now()).roles,requireDeletePermission:replacing});
    guard();lease.current(Date.now());
  };
  try{await full();}catch(error){try{sdk.close();}catch(closeError){preserveCloseFailure(error,closeError);}throw error;}
  return Object.freeze({
    request:(url,options={})=>{
      guard();if((options.method??'GET')==='POST'){
        if(replacing)fail('REPLACEMENT_NAMED_WRITE_REQUIRED');
        lease.consumeAdmission(Date.now()); // Every possible write consumes admission.
        if(options.signal?.aborted||!canaryPin)fail('FINANCIAL_ADMISSION_REQUIRED');
      }return sdk.request(url,options);
    },
    async requestPreviewReplacement(url,options,pins){
      guard();if(!replacing||typeof sdk.requestPreviewReplacement!=='function')fail('REPLACEMENT_REQUIRED');
      const permit=replacementPermit,admissionExpiresAt=replacementExpiresAt,monotonic=replacementMonotonic;
      replacementPermit=null;replacementExpiresAt=null;replacementMonotonic=null;lease.consumeAdmission(Date.now());
      if(!permit||options?.signal?.aborted||text(pins)!==text(permit))fail('REPLACEMENT_ADMISSION_REQUIRED');
      if(!Number.isFinite(monotonic)||performance.now()<monotonic||performance.now()-monotonic>FINANCIAL_ADMISSION_TTL_MS)fail('REPLACEMENT_ADMISSION_EXPIRED');
      return sdk.requestPreviewReplacement(url,options,pins,{admissionExpiresAt});
    },
    // Refresh is explicit, before the financial publisher's ten-second window.
    // It changes neither identity nor permissions and never refreshes tokens.
    async refreshPreflight(){guard();lease.invalidate();replacementPermit=null;observation?.close();await requireProtectedOwnerCheckout();return full();},
    async verifyDestinationAccess(input={}){
      // Consume before validation or any await. Failed admission, refresh and
      // a consumed/expired write cannot mint a second replacement permit.
      if(storageOnly){if(replacementAdmissionAttempted)fail('REPLACEMENT_ADMISSION_CLOSED');replacementAdmissionAttempted=true;}
      const {target,operation,signal,revisionSha256:requestedRevision,previousGeneration,previousDisplaySha256,candidateSha256:requestedCandidate,registrationSha256}=input;
      lease.clearAdmission();
      if(!object(target)||Object.keys(target).sort().join('|')!=='bucket|object'||target.bucket!==LATEST_TARGET.bucket
        ||target.object!==LATEST_TARGET.object||operation!==(replacing?'replace-accepted-preview':'create-accepted-preview')||!canaryPin)fail('CANARY_REQUIRED');
      if(replacing){replacementPermit=null;
        if(requestedRevision!==revisionSha256||requestedCandidate!==candidateSha256||previousDisplaySha256!==revision.previousDisplaySha256
          ||registrationSha256!==hash(acceptedPreviewRegistrationText(revision.registration))||!GEN.test(previousGeneration||''))fail('REPLACEMENT_BINDING');
        if(!storageOnly){observation?.consume();if(!observation)fail('OBSERVATION_REQUIRED');}}
      await live(signal);await readCanary(sdk.requestCanary,canaryPin,signal);
      guard();lease.current(Date.now());if(signal?.aborted)fail('ABORTED');
      if(canaryPin.candidateSha256!==canaryCandidateSha256)fail('REGISTERED_CANDIDATE');
      const admittedAt=Date.now();
      if(replacing){replacementPermit={revisionSha256,previousGeneration,previousDisplaySha256,previousRegistrationSha256:revision.previousRegistrationSha256};replacementExpiresAt=admittedAt+FINANCIAL_ADMISSION_TTL_MS;replacementMonotonic=performance.now();}
      lease.mintAdmission(admittedAt);
    },
    beginNativeCanaryObservation(){guard();if(storageOnly)fail('VISUAL_OBSERVATION_NOT_AVAILABLE');if(!replacing||!canaryPin||observation)fail('OBSERVATION_REQUIRED');
      observation=createReplacementObservation({revisionSha256,candidateSha256,pin:canaryPin});return observation.begin();},
    attestNativeCanaryObservation(value){guard();if(storageOnly)fail('VISUAL_OBSERVATION_NOT_AVAILABLE');if(!replacing||!observation)fail('OBSERVATION_REQUIRED');return observation.attest(value);},
    async verifyRegisteredCanary(){
      guard();if(canaryClosed)fail('CANARY_CLOSED');canaryClosed=true;
      const signal=AbortSignal.timeout(30000);
      try{
        await requireProtectedOwnerCheckout();await live(signal);
        const pin=await readRegisteredOwnerCanary({requestCanary:sdk.requestCanary,registration:FIXED_REGISTERED_CANARY,candidateSha256:canaryCandidateSha256,signal});
        guard();lease.current(Date.now());if(signal.aborted)fail('ABORTED');
        canaryPin=Object.freeze(pin);
        return {status:'existing-verified',code:'REGISTERED_CANARY_READBACK_VERIFIED',pin:structuredClone(pin)};
      }catch(error){const diagnostics=failureDiagnostics(error),reason=canaryFailureReason(error);let closeError;
        try{close();}catch(error){closeError=error;}
        return attachFailureDiagnostics({status:'blocked',code:'REGISTERED_CANARY_READBACK_FAILED',reason},diagnostics,closeError);}
    },
    async createCanary(){
      if(replacing)fail('REPLACEMENT_EXISTING_CANARY_ONLY');
      guard();if(canaryClosed)fail('CANARY_CLOSED');canaryClosed=true;
      let writing=false,stage='protected-checkout';const signal=AbortSignal.timeout(30000);
      try{
        // The first write independently checks actual protected source before
        // its live identity/policy read; no caller can assert this approval.
        await requireProtectedOwnerCheckout();stage='initial-boundary';await live(signal);
        stage='presence';
        const url=canaryUrl(undefined,true),head=await sdk.requestCanary({method:'HEAD',media:true,signal});
        if(response(head,url,{missing:true}))fail('CANARY_EXISTS');
        stage='write-boundary';await live(signal);
        const fields={uuid:crypto.randomUUID(),createdAt:new Date().toISOString(),candidateSha256};
        const bytes=renderOwnerPhoneCanary(fields),sha256=hash(bytes),custom={schema:'xuan.owner-phone-canary.v1',...fields,canarySha256:sha256};
        if(signal.aborted)fail('ABORTED');writing=true;stage='write';
        // The bridge reconstructs exactly the fixed nonfinancial document and
        // metadata. It does not accept arbitrary HTML, metadata or a CAS value.
        const ack=await sdk.createCanary({...fields,signal});
        stage='ack';
        const upload='https://storage.googleapis.com/upload/storage/v1/b/'+CANARY_TARGET.bucket+'/o?uploadType=multipart&ifGenerationMatch=0';response(ack,upload);
        if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(ack.headers.get('content-type')||''))fail('CANARY_METADATA_TYPE');
        const m=strictJson(decoder.decode(await bounded(ack,16000)));
        if(m.bucket!==CANARY_TARGET.bucket||m.name!==CANARY_TARGET.object||!GEN.test(m.generation)||String(m.size)!==String(bytes.length)
          ||m.contentType!==LATEST_HEADERS.contentType||m.contentDisposition!==LATEST_HEADERS.contentDisposition
          ||m.cacheControl!==LATEST_HEADERS.cacheControl||text(m.metadata)!==text(custom))fail('CANARY_ACK');
        const pin={...fields,generation:m.generation,sha256};stage='readback';await readCanary(sdk.requestCanary,pin,signal);
        guard();lease.current(Date.now());if(signal.aborted)fail('ABORTED');
        canaryPin=Object.freeze(pin);
        return {status:'published-verified',code:'CANARY_PINNED_READBACK_VERIFIED',pin:structuredClone(pin)};
      }catch(error){close();return {status:writing&&error?.status===412?'conflict':writing?'unknown':'blocked',stage,
        reason:/^[A-Z][A-Z0-9_]{1,99}$/.test(error?.safeCode||'')?error.safeCode:'CANARY_VALIDATION_FAILED',
        code:writing&&error?.status===412?'CANARY_CAS_CONFLICT_NO_RETRY':writing?'CANARY_WRITE_OUTCOME_UNKNOWN':
          error?.safeCode==='OWNER_ACCESS_CANARY_EXISTS'?'CANARY_EXISTS':'CANARY_ACCESS_OR_VALIDATION_FAILED'};}
    },
    close,
  });
}
