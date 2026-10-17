// Pure, closed projection. Never retain an OAuth response or unknown field value.
import crypto from 'node:crypto';
import {assertPrivateBinding} from '../../binding.mjs';
export const REGISTRATION_AUDIT_SPEC='IB-ORDERS-REGISTRATION-AUDIT-v1';
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value')&&Object.getOwnPropertyDescriptor(x,k).enumerable);
const exact=(x,keys)=>plain(x)&&Reflect.ownKeys(x).every(k=>typeof k==='string')&&Reflect.ownKeys(x).sort().join('|')===[...keys].sort().join('|');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const client=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(x);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':plain(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const fail=()=>{throw Error('REGISTRATION_AUDIT_INVALID');};
const URI=x=>{try{const u=new URL(x);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>0&&Number(u.port)<=65535&&x===`http://127.0.0.1:${u.port}/oauth/ib/callback`;}catch{return false;}};
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const REQUIRED=['clientId','redirectUris','scope','authMethod','grantTypes','responseTypes'];
const STATES=['match','missing','invalid','different'];
const LABELS=['returned-same','returned-different','omitted','invalid'];
const AUTH_METHODS=['none','client_secret_basic','client_secret_post','client_secret_jwt','private_key_jwt'];
const observedAuth=r=>!Object.hasOwn(r,'token_endpoint_auth_method')?'missing':typeof r.token_endpoint_auth_method!=='string'?'invalid':AUTH_METHODS.includes(r.token_endpoint_auth_method)?r.token_endpoint_auth_method:'unsupported';
const authCheck=x=>x==='none'?'match':x==='missing'?'missing':x==='invalid'?'invalid':'different';
const SECRETS=['absent','null','empty','nonempty-string','invalid-type'];
const SIGNING=['absent','present-unused-under-none','present-with-other-auth'];
const reasonNames={clientId:'CLIENT_ID',redirectUris:'REDIRECT_URIS',scope:'SCOPE',authMethod:'AUTH_METHOD',grantTypes:'GRANT_TYPES',responseTypes:'RESPONSE_TYPES'};
const reasonsFor=(checks,secret)=>[
  ...(checks.document==='invalid'?['DOCUMENT_INVALID']:[]),
  ...REQUIRED.filter(k=>checks[k]!=='match').map(k=>reasonNames[k]+'_'+checks[k].toUpperCase()),
  ...(secret!=='absent'?['UNEXPECTED_CLIENT_SECRET_FIELD']:[]),
];
export function registrationRequestProfile(redirectUri){
  if(!URI(redirectUri))fail();return {client_name:'XUAN Preopen Cloud Read-only v2',scope:'mcp.read',grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',redirect_uris:[redirectUri]};
}
export const registrationRequestHash=redirectUri=>sha(canonical(registrationRequestProfile(redirectUri)));
const stringCheck=(r,k,want)=>!Object.hasOwn(r,k)?'missing':typeof r[k]!=='string'?'invalid':r[k]===want?'match':'different';
const denseStrings=a=>{
  if(!Array.isArray(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length>32)return null;
  const keys=Reflect.ownKeys(a);if(keys.length!==a.length+1)return null;
  const out=[];for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,String(i));
    if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string')return null;out.push(d.value);}
  if(keys.some(k=>typeof k!=='string'||k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))return null;return out;
};
const arrayCheck=(r,k,want)=>{
  if(!Object.hasOwn(r,k))return 'missing';const a=denseStrings(r[k]);
  if(!a||new Set(a).size!==a.length)return 'invalid';
  return a.length===want.length&&want.every(v=>a.includes(v))?'match':'different';
};
export function assessRegistration(raw,context){
  if(!exact(context,['attemptId','operationId','approvalSha256','codeSha256','redirectUri','observedAtUtc','httpStatus'])
    ||!uuid(context.attemptId)||!uuid(context.operationId)||!hex(context.approvalSha256)||!hex(context.codeSha256)||!URI(context.redirectUri)
    ||!iso(context.observedAtUtc)||!Number.isInteger(context.httpStatus)||context.httpStatus<200||context.httpStatus>299)fail();
  const object=plain(raw),r=object?raw:{},profile=registrationRequestProfile(context.redirectUri);
  const checks={document:object?'object':'invalid',clientId:!Object.hasOwn(r,'client_id')?'missing':client(r.client_id)?'match':'invalid',
    redirectUris:arrayCheck(r,'redirect_uris',profile.redirect_uris),scope:stringCheck(r,'scope','mcp.read'),authMethod:stringCheck(r,'token_endpoint_auth_method','none'),
    grantTypes:arrayCheck(r,'grant_types',profile.grant_types),responseTypes:arrayCheck(r,'response_types',profile.response_types)};
  const secret=!Object.hasOwn(r,'client_secret')?'absent':r.client_secret===null?'null':typeof r.client_secret!=='string'?'invalid-type':r.client_secret.length?'nonempty-string':'empty';
  const label=!Object.hasOwn(r,'client_name')?'omitted':typeof r.client_name!=='string'?'invalid':r.client_name===profile.client_name?'returned-same':'returned-different';
  const signing=!Object.hasOwn(r,'token_endpoint_auth_signing_alg')?'absent':checks.authMethod==='match'?'present-unused-under-none':'present-with-other-auth';
  const reasons=reasonsFor(checks,secret);
  return validateRegistrationAudit({spec:REGISTRATION_AUDIT_SPEC,...context,issuer:'https://api.ibkr.com',resource:'https://api.ibkr.com/v1/api/mcp-public',
    requestProfileSha256:registrationRequestHash(context.redirectUri),clientId:checks.clientId==='match'?r.client_id:null,checks,
    profileAccepted:reasons.length===0,reasons,displayNameEvidence:label,observedAuthMethod:observedAuth(r),clientSecretState:secret,signingAlgorithmEvidence:signing,
    managementCredentialReturned:Object.hasOwn(r,'registration_access_token'),managementCredentialPersisted:false,usableForAuthorization:false});
}
export function validateRegistrationAudit(v){
  const keys=['spec','attemptId','operationId','approvalSha256','codeSha256','redirectUri','observedAtUtc','httpStatus','issuer','resource','requestProfileSha256','clientId','checks',
    'profileAccepted','reasons','displayNameEvidence','observedAuthMethod','clientSecretState','signingAlgorithmEvidence','managementCredentialReturned','managementCredentialPersisted','usableForAuthorization'];
  if(!exact(v,keys)||v.spec!==REGISTRATION_AUDIT_SPEC||!uuid(v.attemptId)||!uuid(v.operationId)||!hex(v.approvalSha256)||!hex(v.codeSha256)||!URI(v.redirectUri)
    ||!iso(v.observedAtUtc)||!Number.isInteger(v.httpStatus)||v.httpStatus<200||v.httpStatus>299||v.issuer!=='https://api.ibkr.com'||v.resource!=='https://api.ibkr.com/v1/api/mcp-public'
    ||v.requestProfileSha256!==registrationRequestHash(v.redirectUri)||!exact(v.checks,['document',...REQUIRED])||!['object','invalid'].includes(v.checks.document)
    ||REQUIRED.some(k=>!STATES.includes(v.checks[k]))||!['match','missing','invalid'].includes(v.checks.clientId)
    ||(v.checks.clientId==='match'?!client(v.clientId):v.clientId!==null)||!LABELS.includes(v.displayNameEvidence)||!SECRETS.includes(v.clientSecretState)
    ||![...AUTH_METHODS,'unsupported','missing','invalid'].includes(v.observedAuthMethod)||v.checks.authMethod!==authCheck(v.observedAuthMethod)
    ||!SIGNING.includes(v.signingAlgorithmEvidence)||v.signingAlgorithmEvidence==='present-unused-under-none'&&v.checks.authMethod!=='match'
    ||v.signingAlgorithmEvidence==='present-with-other-auth'&&v.checks.authMethod==='match'
    ||v.checks.document==='invalid'&&(REQUIRED.some(k=>v.checks[k]!=='missing')||v.clientSecretState!=='absent'||v.displayNameEvidence!=='omitted'||v.signingAlgorithmEvidence!=='absent'||v.managementCredentialReturned!==false)
    ||typeof v.managementCredentialReturned!=='boolean'||v.managementCredentialPersisted!==false||v.usableForAuthorization!==false
    ||!denseStrings(v.reasons)||canonical(v.reasons)!==canonical(reasonsFor(v.checks,v.clientSecretState))||v.profileAccepted!==(v.reasons.length===0))fail();
  // Reconstruct all fields explicitly. This function accepts no unknown property.
  return Object.freeze({spec:REGISTRATION_AUDIT_SPEC,attemptId:v.attemptId,operationId:v.operationId,approvalSha256:v.approvalSha256,codeSha256:v.codeSha256,
    redirectUri:v.redirectUri,observedAtUtc:v.observedAtUtc,httpStatus:v.httpStatus,issuer:v.issuer,resource:v.resource,requestProfileSha256:v.requestProfileSha256,clientId:v.clientId,
    checks:Object.freeze({...v.checks}),profileAccepted:v.profileAccepted,reasons:Object.freeze([...v.reasons]),displayNameEvidence:v.displayNameEvidence,
    observedAuthMethod:v.observedAuthMethod,clientSecretState:v.clientSecretState,signingAlgorithmEvidence:v.signingAlgorithmEvidence,managementCredentialReturned:v.managementCredentialReturned,
    managementCredentialPersisted:false,usableForAuthorization:false});
}
export const registrationAuditHash=v=>sha(canonical(validateRegistrationAudit(v)));

// The production factory accepts only a byte-committed private binding.
export function createBoundAudit(binding){
  assertPrivateBinding(binding);
// An independent fixed fresh claim is admitted without relabelling it as an old
// phase1 continuation. The old path/schema/budget contract stays unchanged.
const FRESH_RUNTIME=binding.fresh.runtime;
function freshClaim(expected,claimPath,auditPath){
  return claimPath===FRESH_RUNTIME+'/fresh.claim.safe.json'&&auditPath===FRESH_RUNTIME+'/fresh.registration-audit.safe.json'
    &&exact(expected,['spec','stage','operationId','authorizationId','previousRecordsDigest','approvalSha256','code','oldRemainingRegistrationMaximum','remainingRegistrationMaximum','cumulativePossibleRegistrationMaximum'])
    &&expected.spec==='IB-ORDERS-FRESH-EXECUTION-v1'&&expected.stage==='initial-orders'
    &&expected.operationId===binding.fresh.operationId&&expected.authorizationId===binding.fresh.authorizationId
    &&expected.previousRecordsDigest===binding.previousDigest&&hex(expected.approvalSha256)&&plain(expected.code)
    &&expected.oldRemainingRegistrationMaximum===0&&expected.remainingRegistrationMaximum===1&&expected.cumulativePossibleRegistrationMaximum===3;
}
const auditPaths=(claimPath,auditPath,expected)=>freshClaim(expected,claimPath,auditPath);
// Generic injected filesystem seam; the operator chooses both fixed production paths.
// A failed/partial write is never removed or retried. This is an acknowledgement
// protocol, not a guarantee against disk exhaustion, power loss or hardware faults.
async function persistRegistrationAudit(audit,{fs,claimPath,auditPath,expectedClaim,parse,uid,signal}={}){
  const stop=()=>{throw Error('REGISTRATION_AUDIT_PERSISTENCE_UNCONFIRMED');};
  let claimHandle,outputHandle,dirHandle,readHandle;
  try{
    const safe=validateRegistrationAudit(audit),expected=JSON.parse(JSON.stringify(expectedClaim));
    if(!fs||typeof parse!=='function'||!Number.isInteger(uid)||uid<0||typeof claimPath!=='string'||typeof auditPath!=='string'
      ||!auditPaths(claimPath,auditPath,expected)||expected.operationId!==safe.operationId||expected.approvalSha256!==safe.approvalSha256
      ||!freshClaim(expected,claimPath,auditPath))stop();
    const check=()=>{if(signal?.aborted)stop();};
    const parent=claimPath.slice(0,claimPath.lastIndexOf('/'));
    const stat=(s,kind)=>s&&!s.isSymbolicLink()&&s.uid===uid&&(s.mode&0o777)===(kind==='dir'?0o700:0o600)
      &&(kind==='dir'?s.isDirectory():s.isFile()&&s.size<=65536&&s.nlink===1);
    const same=(a,b)=>a.ino===b.ino&&a.dev===b.dev;
    check();const d=await fs.lstat(parent);if(!stat(d,'dir'))stop();
    const c=await fs.lstat(claimPath);if(!stat(c,'file'))stop();
    claimHandle=await fs.open(claimPath,'r');if(!stat(await claimHandle.stat(),'file')||!same(c,await claimHandle.stat()))stop();
    const claimBytes=await claimHandle.readFile();await claimHandle.close();claimHandle=null;check();
    if(canonical(parse(claimBytes.toString()))!==canonical(expected))stop();
    const envelope={spec:'IB-ORDERS-REGISTRATION-AUDIT-ENVELOPE-v1',claimSha256:sha(claimBytes),registrationAudit:safe};
    const bytes=Buffer.from(JSON.stringify(envelope)+'\n');
    outputHandle=await fs.open(auditPath,'wx',0o600);check();if(!stat(await outputHandle.stat(),'file'))stop();
    await outputHandle.writeFile(bytes);check();await outputHandle.sync();await outputHandle.close();outputHandle=null;check();
    dirHandle=await fs.open(parent,'r');const opened=await dirHandle.stat();if(!stat(opened,'dir')||!same(d,opened))stop();
    await dirHandle.sync();await dirHandle.close();dirHandle=null;check();
    const st=await fs.lstat(auditPath);if(!stat(st,'file'))stop();
    readHandle=await fs.open(auditPath,'r');if(!stat(await readHandle.stat(),'file')||!same(st,await readHandle.stat()))stop();
    const readback=await readHandle.readFile();await readHandle.close();readHandle=null;check();
    if(!readback.equals(bytes)||!same(d,await fs.lstat(parent))||!same(c,await fs.lstat(claimPath))||!(await fs.readFile(claimPath)).equals(claimBytes))stop();
    const readEnvelope=parse(readback.toString());if(!exact(readEnvelope,['spec','claimSha256','registrationAudit'])
      ||readEnvelope.spec!==envelope.spec||readEnvelope.claimSha256!==envelope.claimSha256||registrationAuditHash(readEnvelope.registrationAudit)!==registrationAuditHash(safe))stop();
    check();return {persisted:true,auditSha256:registrationAuditHash(safe)};
  }catch{stop();}finally{for(const h of [claimHandle,outputHandle,dirHandle,readHandle])if(h)try{await h.close();}catch{}}
}

// Offline read/verification seam only. No recovery authorization or network action.
// The caller must retain the expected attempt and audit digest from its safe receipt.
async function readPersistedRegistrationAudit({fs,claimPath,auditPath,expectedClaim,expectedAttemptId,expectedAuditSha256,expectedCodeSha256,parse,uid}={}){
  try{
    expectedClaim=JSON.parse(JSON.stringify(expectedClaim));
    if(!uuid(expectedAttemptId)||!hex(expectedAuditSha256)||!hex(expectedCodeSha256)||!Number.isInteger(uid)||typeof parse!=='function'
      ||typeof claimPath!=='string'||!auditPaths(claimPath,auditPath,expectedClaim))fail();
    const parent=claimPath.slice(0,claimPath.lastIndexOf('/'));
    for(const [name,dir] of [[parent,true],[claimPath,false],[auditPath,false]]){const s=await fs.lstat(name);
      if(s.isSymbolicLink()||s.uid!==uid||(s.mode&0o777)!==(dir?0o700:0o600)||!(dir?s.isDirectory():s.isFile()&&s.nlink===1&&s.size<=65536))fail();}
    const claim=await fs.readFile(claimPath),bytes=await fs.readFile(auditPath),envelope=parse(bytes.toString());
    if(canonical(parse(claim.toString()))!==canonical(expectedClaim)||!exact(envelope,['spec','claimSha256','registrationAudit'])
      ||envelope.spec!=='IB-ORDERS-REGISTRATION-AUDIT-ENVELOPE-v1'||envelope.claimSha256!==sha(claim))fail();
    const audit=validateRegistrationAudit(envelope.registrationAudit);
    if(audit.attemptId!==expectedAttemptId||registrationAuditHash(audit)!==expectedAuditSha256||audit.operationId!==expectedClaim.operationId
      ||audit.approvalSha256!==expectedClaim.approvalSha256||audit.codeSha256!==expectedCodeSha256)fail();
    return audit;
  }catch{throw Error('REGISTRATION_AUDIT_PERSISTENCE_UNCONFIRMED');}
}

return {persistRegistrationAudit,readPersistedRegistrationAudit};
}
