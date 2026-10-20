// Private operator preparation. Import and the default CLI are strictly offline.
import crypto from 'node:crypto';
import {assertPrivateBinding} from './binding.mjs';
import {validateRegistrationAudit,registrationAuditHash} from './source/scripts/xuan-ib-oauth-registration-audit.mjs';


// Pure engine only. This module acquires no filesystem, network, process or
// browser capability and never returns a native adapter.
export function createOperator(binding){
  assertPrivateBinding(binding);
const SPEC='IB-ORDERS-LIVE-OPERATOR-LOCAL-v1';
const FIXED=binding.fixed;
// The fresh operation has its own fixed identity and durable claim. No caller may
// select an alternate resource, path, account, endpoint or refresh continuation.
const FRESH=binding.fresh;
function freshClaimRecord(a){
  if(a?.spec!==FRESH.spec||a.stage!=='initial-orders'||a.operationId!==FRESH.operationId||a.authorizationId!==FRESH.authorizationId
    ||JSON.stringify(a.requestIds)!==JSON.stringify([FRESH.requestId,FRESH.unusedRequestId])||a.precedingVersion!=='14'
    ||a.previousRecordsDigest!==binding.previousDigest||!hex(a.approvalSha256)||!plain(a.code))fail('APPROVAL_REQUIRED');
  return {spec:FRESH.spec,stage:'initial-orders',operationId:FRESH.operationId,authorizationId:FRESH.authorizationId,
    previousRecordsDigest:a.previousRecordsDigest,approvalSha256:a.approvalSha256,code:a.code,
    oldRemainingRegistrationMaximum:0,remainingRegistrationMaximum:binding.existingClient?0:1,cumulativePossibleRegistrationMaximum:3};
}
const SOURCE_HASHES=Object.freeze({
  "scripts/xuan-ib-oauth-registration-audit.mjs": "02bf0ea153f07732b81fda2cdb2b9f377a08d34fc4977dabb4f1cec3b150d527",
  "scripts/xuan-ib-cloud-oauth-bootstrap.mjs": "5d279ab4e98c7aafa09f1b2de23e28e5beb7afedf8595a3374e2c3885ac355f3",
  "cloud/xuan-preopen/cloud_io.mjs": "edf0538bb1f2a5ecf63757736b79eb0ee0c47e37606a1eae2291a55da88020cf",
  "cloud/xuan-preopen/ib_diagnostics.mjs": "2c4f889a8b3f2ba11b34aa5f2fea35fa0d9d03d15418850777a15d3c92596669",
  "scripts/xuan-ib-decision-menu.mjs": "f645ad9e06fa1bfa67694a04260cad24eb74ca66a38831aec4ad5ab0d2c9d92c"
});
const CODES=new Set(['OFFLINE_ONLY','REQUEST_INVALID','APPROVAL_REQUIRED','CODE_MISMATCH','PRIVATE_FILE_INVALID',
  'OPERATION_ALREADY_CLAIMED','IDENTITY_INVALID','MAINTENANCE_UNCONFIRMED','JOB_CONFIG_INVALID','DEADLINE_EXCEEDED',
  'BOOTSTRAP_FAILED','BOOTSTRAP_OUTCOME_UNKNOWN','CREDENTIAL_METADATA_INVALID','WINDOW_OUTSIDE_APPROVAL',
  'RUN_OUTCOME_UNKNOWN','CONTROL_IDENTITY_FAILED','CONTROL_MAINTENANCE_FAILED','EXECUTION_FAILED','RECEIPT_INVALID','VERSION_CHAIN_INVALID','CANCELLED','INTERNAL_FAILED','OPERATION_IN_PROGRESS','ORDERS_ACCEPTANCE_PASSED',
  'STAGE_ALREADY_CLAIMED','READINESS_FAILED','REFRESH_WINDOW_NOT_REACHED','INITIAL_ORDERS_PASSED_REFRESH_PENDING','NATURAL_REFRESH_PASSED']);
class SafeFailure extends Error{constructor(code){super(CODES.has(code)?code:'INTERNAL_FAILED');}}
const fail=c=>{throw new SafeFailure(c);};
// Recheck current time at every fresh effect boundary, including after imports.
// Legacy callers keep their existing window rules; cancellation always closes.
function executionAdmission(a,signal,clock=Date){
  if(signal?.aborted)fail('CANCELLED');
  if(a?.spec===FRESH.spec){const now=clock.now();
    if(!iso(a.validFromUtc)||!iso(a.validUntilUtc)||now<Date.parse(a.validFromUtc)||now>=Date.parse(a.validUntilUtc))fail('DEADLINE_EXCEEDED');}
}

const safeCode=e=>e instanceof SafeFailure?e.message:'INTERNAL_FAILED';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,ks)=>plain(x)&&Object.keys(x).sort().join('|')===[...ks].sort().join('|');
const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const version=x=>typeof x==='string'&&/^[1-9]\d{0,29}$/.test(x);
const client=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const day=t=>new Date(t+28800000).toISOString().slice(0,10);
const nextDay=t=>Date.parse(day(t)+'T00:00:00.000+08:00')+86400000;
const versionName=v=>`${FIXED.secret}/versions/${v}`;
function versionOf(n){
  if(typeof n!=='string'||!/^projects\/(?:family-portfolio-gateway|860729177589)\/secrets\/xuan-preopen-ib-mcp\/versions\/[1-9]\d{0,29}$/.test(n))fail('VERSION_CHAIN_INVALID');
  return n.split('/').at(-1);
}
const CONTROL_OPS=new Set(['startup','identity','maintenance','run','operation','execution','receipt']);
const CONTROL_STAGES=new Set(['init-frame','sdk-identity','transport-import','dispatch','rpc']);
const CONTROL_RESOURCES=new Set(['none','run-state-list','scheduler-state','job-config','secret-version-metadata','run-start','operation-status','execution-status','safe-receipt']);
const CONTROL_CATEGORIES=new Set(['VALIDATION_REJECTED','HTTP_REJECTED','RESPONSE_REJECTED','READ_TIMEOUT','CONNECT_TIMEOUT','TLS_ERROR','CONNECTION_ERROR','GOOGLE_AUTH_ERROR','FILE_ACCESS_ERROR','OS_ERROR','JSON_INVALID','UNICODE_INVALID','INTERNAL_ERROR','RPC_TIMEOUT','RPC_CHILD_ERROR','RPC_CHILD_CLOSED','RPC_FRAME_INVALID','RPC_FRAME_TOO_LARGE','RPC_UNEXPECTED_FRAME']);
const CONTROL_TYPES=new Set(['none','unclassified','Closed','builtins.RuntimeError','builtins.TimeoutError','builtins.OSError','builtins.PermissionError','builtins.FileNotFoundError','builtins.UnicodeDecodeError','json.decoder.JSONDecodeError','requests.exceptions.ReadTimeout','requests.exceptions.ConnectTimeout','requests.exceptions.SSLError','requests.exceptions.ConnectionError','requests.exceptions.Timeout','google.auth.exceptions.RefreshError','google.auth.exceptions.TransportError','googlecloudsdk.core.util.files.Error']);
const CONTROL_ORIGINS=new Set(['unknown','createRpc','main','live_identity','call','session','unique','pairs','maintenance','job','version','executions_list','dispatch','run','operation','execution','receipt']);
function safeControlDiagnostic(x,expectedOperation=null){
  if(!exact(x,['spec','stage','operation','resource','category','exceptionType','origin','line','httpStatus'])||x.spec!=='IB-ORDERS-CONTROL-DIAGNOSTIC-v1'
    ||!CONTROL_STAGES.has(x.stage)||!CONTROL_OPS.has(x.operation)||!CONTROL_RESOURCES.has(x.resource)||!CONTROL_CATEGORIES.has(x.category)
    ||!CONTROL_TYPES.has(x.exceptionType)||!CONTROL_ORIGINS.has(x.origin)||!(x.line===null||Number.isInteger(x.line)&&x.line>0&&x.line<=5000)
    ||!(x.httpStatus===null||Number.isInteger(x.httpStatus)&&x.httpStatus>=100&&x.httpStatus<=599)
    ||expectedOperation!==null&&x.operation!==expectedOperation&&!(x.operation==='startup'&&['init-frame','sdk-identity','transport-import'].includes(x.stage)))return null;
  return {spec:x.spec,stage:x.stage,operation:x.operation,resource:x.resource,category:x.category,exceptionType:x.exceptionType,origin:x.origin,line:x.line,httpStatus:x.httpStatus};
}
// Closed JSON parser, including duplicate keys at every depth. Never reports input.
function safeJson(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)fail('REQUEST_INVALID');
  let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(raw[i]||'!'))i++;};
  const str=()=>{const s=i++;while(i<raw.length){const c=raw[i++];if(c==='"'){try{return JSON.parse(raw.slice(s,i));}catch{break;}}if(c==='\\')i++;}fail('REQUEST_INVALID');};
  const val=(depth=0)=>{if(depth>30)fail('REQUEST_INVALID');ws();const c=raw[i];
    if(c==='"')return str();
    if(c==='{'||c==='['){i++;const obj=c==='{',seen=new Set();ws();if(raw[i]===(obj?'}':']')){i++;return;}
      for(;;){ws();if(obj){if(raw[i]!=='"')fail('REQUEST_INVALID');const k=str();if(seen.has(k)||k==='__proto__')fail('REQUEST_INVALID');seen.add(k);ws();if(raw[i++]!==':')fail('REQUEST_INVALID');}
        val(depth+1);ws();if(raw[i]===(obj?'}':']')){i++;return;}if(raw[i++]!==',')fail('REQUEST_INVALID');}}
    const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));if(!m)fail('REQUEST_INVALID');i+=m[0].length;
  };
  try{val();ws();if(i!==raw.length)fail('REQUEST_INVALID');return JSON.parse(raw);}catch{fail('REQUEST_INVALID');}
}
function validateJob(job){
  const t=job?.template?.template,c=t?.containers;
  if(job?.name!==`projects/${FIXED.project}/locations/${FIXED.region}/jobs/${FIXED.job}`||job.reconciling===true
    ||job.template?.taskCount!==1||job.template?.parallelism!==1||t?.serviceAccount!==FIXED.sourceSa||t?.timeout!=='75s'||(t?.maxRetries??0)!==0
    ||!Array.isArray(c)||c.length!==1||c[0].image!==FIXED.image||JSON.stringify(c[0].command)!==JSON.stringify(FIXED.command)
    ||Object.hasOwn(c[0],'args')&&!Array.isArray(c[0].args)||c[0].args?.length||c[0].env?.length||c[0].volumeMounts?.length||t.volumes?.length
    ||c[0].resources?.limits?.cpu!=='1'||c[0].resources?.limits?.memory!=='512Mi')fail('JOB_CONFIG_INVALID');
  return true;
}
function validateMaintenance(g,gh,a,expectedVersion,now){
  if(!plain(g)||g.complete!==true||!iso(g.observedAtUtc)||Math.abs(now-Date.parse(g.observedAtUtc))>4500
    ||g.identityMatched!==true||!Array.isArray(g.schedulers)||g.schedulers.length!==2
    ||FIXED.schedulers.some(n=>g.schedulers.filter(s=>s.name===n&&s.state==='PAUSED').length!==1)
    ||!Array.isArray(g.jobs)||g.jobs.length!==4||FIXED.consumerJobs.some(n=>g.jobs.filter(j=>j.name===n&&j.complete===true&&j.unfinished===0&&j.running===0).length!==1)
    ||!Array.isArray(g.eodJobNames)||JSON.stringify([...g.eodJobNames].sort())!==JSON.stringify([...FIXED.eodJobs].sort())
    ||g.eodExecutionReads!==0||g.secret?.version!==expectedVersion||g.secret?.state!=='ENABLED'
    ||!plain(gh)||gh.complete!==true||!iso(gh.observedAtUtc)||Math.abs(now-Date.parse(gh.observedAtUtc))>4500
    ||gh.unfinished!==0||!(gh.mode==='off'||['disabled_manually','disabled_inactivity'].includes(gh.workflowState))
    ||a.manualHold.attested!==true||a.eodQuiet.attested!==true||now>=Date.parse(a.validUntilUtc))fail('MAINTENANCE_UNCONFIRMED');
  validateJob(g.probe);
  return {entrypointsPaused:true,executionsDrained:true,manualOldVersionRunsBlocked:true,observedVersion:expectedVersion};
}
function validateReceipt(r,request,index,execution){
  // Cloud Run API resource names and CLOUD_RUN_EXECUTION have distinct contracts.
  // Bind the complete fixed-resource path before accepting the producer's short name.
  const match=typeof execution==='string'&&new RegExp('^projects/'+FIXED.project+'/locations/'+FIXED.region+'/jobs/'+FIXED.job+'/executions/(xuan-preopen-orders-probe-[a-z0-9-]+)$').exec(execution);
  if(!match)fail('RECEIPT_INVALID');
  const used=versionOf(r?.consumedCredentialVersion);
  if(r?.status!=='passed'||r.mode!=='cloud-orders-probe'||r.requestId!==request.requestId||r.dataDate!==request.dataDate||r.expiresAt!==request.expiresAt
    ||r.execution!==match[1]||r.upstreamAttempted!==true||r.ordersCalls!==1||r.refreshCalls!==index
    ||r.credentialClientMatched!==true||r.credentialVersionMatched!==true||used!==request.credentialBinding.version
    ||!iso(r.startedAt)||!iso(r.completedAt)||Date.parse(r.completedAt)<Date.parse(r.startedAt)||!hex(r.receiptSha256)
    ||r.associationBasis!=='owner-attested'||!['matched','not-provided'].includes(r.responseAccountEvidence)
    ||!['response-account-id','not-provided'].includes(r.nativeIdentityEvidence)
    ||(r.responseAccountEvidence==='matched')!==(r.nativeIdentityEvidence==='response-account-id'))fail('RECEIPT_INVALID');
  if(index===0&&(r.savedCredentialVersion!==null||r.credentialPersistence!=='not-needed'))fail('VERSION_CHAIN_INVALID');
  if(index===1&&(r.credentialPersistence!=='saved'||BigInt(versionOf(r.savedCredentialVersion))<=BigInt(used)))fail('VERSION_CHAIN_INVALID');
  return {consumedCredentialVersion:versionName(used),savedCredentialVersion:index?versionName(versionOf(r.savedCredentialVersion)):null,
    ordersCalls:1,refreshCalls:index,receiptSha256:r.receiptSha256,responseAccountEvidence:r.responseAccountEvidence};
}
function safeRegistration(r){
  if(r===null||r===undefined)return null;
  if(binding.existingClient){
    const pin=binding.existingClient.expected;
    if(!exact(r,['mode','clientId','redirectUri','issuer','resource','tokenEndpointAuthMethod','grantTypes','responseTypes','responseTypesEvidence',
      'registrationScopeEvidence','requestedScope','newRegistrationsMaximum','envelopeSha256','claimSha256','auditSha256','registrationCodeSha256',
      'registeredAtUtc','historicalProfileAccepted','managementCredentialReturned','managementCredentialPersisted','codeSha256'])
      ||r.mode!=='existing-client'||r.clientId!==pin.clientId||r.redirectUri!==FIXED.redirectUri||r.tokenEndpointAuthMethod!=='none'
      ||r.issuer!=='https://api.ibkr.com'||r.resource!=='https://api.ibkr.com/v1/api/mcp-public'
      ||JSON.stringify(r.grantTypes)!=='["authorization_code","refresh_token"]'||JSON.stringify(r.responseTypes)!=='["code"]'
      ||!['rfc7591-default-code','registration-response'].includes(r.responseTypesEvidence)
      ||!['historical-request-match','historical-field-omitted','historical-string-not-retained'].includes(r.registrationScopeEvidence)
      ||r.requestedScope!=='mcp.read'||r.newRegistrationsMaximum!==0
      ||['envelopeSha256','claimSha256','auditSha256','registrationCodeSha256'].some(k=>r[k]!==pin[k])
      ||!iso(r.registeredAtUtc)||typeof r.historicalProfileAccepted!=='boolean'||typeof r.managementCredentialReturned!=='boolean'
      ||r.managementCredentialPersisted!==false||r.codeSha256!==SOURCE_HASHES['scripts/xuan-ib-cloud-oauth-bootstrap.mjs'])fail('BOOTSTRAP_FAILED');
    return structuredClone(r);
  }
  if(!client(r.clientId)||(r.requestedClientName??r.clientName)!=='XUAN Preopen Cloud Read-only v2'||r.redirectUri!==FIXED.redirectUri||r.tokenEndpointAuthMethod!=='none'
    ||JSON.stringify(r.grantTypes)!==JSON.stringify(['authorization_code','refresh_token'])||JSON.stringify(r.responseTypes)!=='["code"]'
    ||r.scope!=='mcp.read'||r.issuer!=='https://api.ibkr.com'||r.resource!=='https://api.ibkr.com/v1/api/mcp-public'||!iso(r.observedAtUtc)
    ||r.codeSha256!==SOURCE_HASHES['scripts/xuan-ib-cloud-oauth-bootstrap.mjs']||typeof r.managementCredentialReturned!=='boolean'||r.managementCredentialPersisted!==false)fail('BOOTSTRAP_FAILED');
  return {clientId:r.clientId,requestedClientName:'XUAN Preopen Cloud Read-only v2',displayNameEvidence:['returned-same','returned-different','omitted','invalid'].includes(r.displayNameEvidence)?r.displayNameEvidence:'not-recorded',redirectUri:FIXED.redirectUri,tokenEndpointAuthMethod:'none',
    grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],scope:'mcp.read',issuer:'https://api.ibkr.com',resource:'https://api.ibkr.com/v1/api/mcp-public',
    observedAtUtc:r.observedAtUtc,codeSha256:r.codeSha256,managementCredentialReturned:r.managementCredentialReturned,managementCredentialPersisted:false};
}
const BOOTSTRAP_CODES=new Set(['BOOTSTRAP_REQUEST_INVALID','BOOTSTRAP_APPROVAL_REQUIRED','BOOTSTRAP_PROFILE_REVIEW_REQUIRED','BOOTSTRAP_REGISTRATION_AUDIT_UNCONFIRMED',
  'BOOTSTRAP_LISTENER_BINDING_INVALID','BOOTSTRAP_CALLBACK_INVALID','BOOTSTRAP_SESSION_EXPIRED','BOOTSTRAP_FINALIZATION_EXPIRED',
  'BOOTSTRAP_CANCELLED','BOOTSTRAP_REPLAY_REJECTED','BOOTSTRAP_OWNER_AUTHORIZATION_REJECTED','BOOTSTRAP_DCR_REJECTED',
  'BOOTSTRAP_DCR_OUTCOME_UNKNOWN','BOOTSTRAP_EXCHANGE_REJECTED','BOOTSTRAP_EXCHANGE_OUTCOME_UNKNOWN','BOOTSTRAP_TOKEN_INVALID',
  'BOOTSTRAP_MAINTENANCE_UNCONFIRMED','BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN','BOOTSTRAP_SECRET_ACK_INVALID',
  'BOOTSTRAP_INTERNAL_FAILED','BOOTSTRAP_AWAITING_OWNER','BOOTSTRAP_SECRET_VERSION_CONFIRMED']);
const BOOTSTRAP_PHASES=new Set(['prepared','listen','register','await-owner','exchange','maintenance-check','secret-write',
  'completed','stopped','expired','finalization-expired','cancelled']);
const EFFECTS=new Set(['not-started','unknown','confirmed','rejected']);
const TRANSPORT_SPEC='IB-ORDERS-OAUTH-TRANSPORT-DIAGNOSTIC-v1';
// Fetch reservation means a request MAY have left the process. It is not wire proof.
// Only fixed metadata is observed; OAuth URLs, headers, bodies and exceptions never enter diagnostics.
function createObservedOAuthFetch(fetchImpl,{onEvent=async()=>{},beforeFetch=()=>{},registrationAllowed=true}={}){
  if(typeof fetchImpl!=='function'||typeof onEvent!=='function'||typeof beforeFetch!=='function'||typeof registrationAllowed!=='boolean')fail('BOOTSTRAP_FAILED');
  const rows={registration:{requestReservations:0,responseReceived:false,httpStatus:null,bodyState:'not-started'},
    exchange:{requestReservations:0,responseReceived:false,httpStatus:null,bodyState:'not-started'}};
  let diagnosticPersistence='confirmed';const pendingDiagnostics=new Set();
  const snapshot=()=>({spec:TRANSPORT_SPEC,diagnosticPersistence,registration:{...rows.registration},exchange:{...rows.exchange}});
  const emit=async()=>{try{await onEvent(snapshot());}catch{fail('BOOTSTRAP_OUTCOME_UNKNOWN');}};
  const postEmit=()=>{diagnosticPersistence=diagnosticPersistence==='unconfirmed'?'unconfirmed':'pending';
    let p;p=Promise.resolve().then(()=>onEvent(snapshot())).then(()=>{},()=>{diagnosticPersistence='unconfirmed';}).finally(()=>{pendingDiagnostics.delete(p);if(!pendingDiagnostics.size&&diagnosticPersistence!=='unconfirmed')diagnosticPersistence='confirmed';});pendingDiagnostics.add(p);};
  const confirmDiagnostics=async({signal}={})=>{let onAbort;try{await Promise.race([Promise.all([...pendingDiagnostics]),new Promise((_,reject)=>{
    onAbort=()=>reject(new SafeFailure('BOOTSTRAP_OUTCOME_UNKNOWN'));if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});})]);
    if(diagnosticPersistence!=='confirmed')fail('BOOTSTRAP_OUTCOME_UNKNOWN');}finally{signal?.removeEventListener('abort',onAbort);}};
  const fetch=async(endpoint,options)=>{
    const kind=endpoint==='https://api.ibkr.com/oauth2/register'?'registration':endpoint==='https://api.ibkr.com/oauth2/api/v1/token'?'exchange':null;
    if(!kind||kind==='registration'&&!registrationAllowed||rows[kind].requestReservations!==0)fail('BOOTSTRAP_FAILED');
    const row=rows[kind];row.requestReservations=1;
    await emit(); // Persist the possible-side-effect boundary before calling fetch.
    if(options?.signal?.aborted)fail('BOOTSTRAP_OUTCOME_UNKNOWN');beforeFetch(endpoint);
    let response;try{response=await fetchImpl(endpoint,options);}catch{await emit();fail('BOOTSTRAP_OUTCOME_UNKNOWN');}
    row.responseReceived=true;row.httpStatus=Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?response.status:null;
    postEmit();
    const body=response?.body;
    if(!body)return response;
    const observedBody={getReader(...args){const reader=body.getReader(...args);return new Proxy(reader,{get(target,key){
      if(key==='read')return async()=>{
        if(row.bodyState==='not-started')row.bodyState='reading';
        let value;try{value=await target.read();}catch{row.bodyState='read-error';postEmit();fail('BOOTSTRAP_OUTCOME_UNKNOWN');}
        if(value.done){row.bodyState='complete';postEmit();}return value;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});}};
    return new Proxy(response,{get(target,key){if(key==='body')return observedBody;
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  };
  return Object.freeze({fetch,snapshot,confirmDiagnostics});
}
function safeBootstrapDiagnostic(result,transport){
  // Whitelist each scalar; never spread the bootstrap result or an OAuth response.
  const code=BOOTSTRAP_CODES.has(result?.code)?result.code:'BOOTSTRAP_DIAGNOSTIC_INVALID';
  const effects={};for(const k of ['registration','codeExchange','secretWrite'])effects[k]=EFFECTS.has(result?.sideEffects?.[k])?result.sideEffects[k]:'unknown';
  const network={spec:TRANSPORT_SPEC,observed:transport?.spec===TRANSPORT_SPEC,diagnosticPersistence:['confirmed','pending','unconfirmed'].includes(transport?.diagnosticPersistence)?transport.diagnosticPersistence:'not-recorded'};
  for(const k of ['registration','exchange']){
    const r=transport?.[k];network[k]={requestReservations:Number.isInteger(r?.requestReservations)&&r.requestReservations>=0&&r.requestReservations<=1?r.requestReservations:null,
      responseReceived:typeof r?.responseReceived==='boolean'?r.responseReceived:null,
      httpStatus:Number.isInteger(r?.httpStatus)&&r.httpStatus>=100&&r.httpStatus<=599?r.httpStatus:null,
      bodyState:['not-started','reading','complete','read-error'].includes(r?.bodyState)?r.bodyState:'unknown'};
  }
  network.observed=network.observed&&['registration','exchange'].every(k=>{
    const r=network[k];return r.requestReservations!==null&&r.responseReceived!==null&&r.bodyState!=='unknown'
      &&(r.requestReservations!==0||r.responseReceived===false&&r.httpStatus===null&&r.bodyState==='not-started')
      &&(r.responseReceived===false?r.httpStatus===null&&r.bodyState==='not-started':r.httpStatus!==null&&r.requestReservations===1);
  });
  const reg=network.registration;let registrationOutcome='unresolved';
  if(network.observed&&reg.requestReservations===0&&effects.registration==='not-started')registrationOutcome='before-request';
  else if(network.observed&&reg.requestReservations===1&&!reg.responseReceived)registrationOutcome='request-reserved-outcome-unknown';
  // Body EOF does not prove parsing ran: a diagnostic sink can fail or stall after EOF.
  else if(network.observed&&reg.responseReceived&&reg.httpStatus>=200&&reg.httpStatus<300&&reg.bodyState==='complete'&&code==='BOOTSTRAP_DCR_OUTCOME_UNKNOWN')registrationOutcome='response-body-complete-outcome-unconfirmed';
  else if(network.observed&&reg.responseReceived&&code==='BOOTSTRAP_PROFILE_REVIEW_REQUIRED')registrationOutcome='response-profile-review-required';
  else if(network.observed&&reg.responseReceived&&code==='BOOTSTRAP_DCR_REJECTED')registrationOutcome='response-rejected';
  else if(network.observed&&effects.registration==='confirmed')registrationOutcome='confirmed';
  else if(network.observed&&reg.responseReceived)registrationOutcome='response-received-outcome-unconfirmed';
  return {code,phase:BOOTSTRAP_PHASES.has(result?.phase)?result.phase:'unrecognized',sideEffects:effects,
    registrationAudit:safeAudit(result?.registrationAudit),registrationAuditPersistence:safeAuditPersistence(result?.registrationAuditPersistence),
    listenerClosed:typeof result?.listenerClosed==='boolean'?result.listenerClosed:null,registrationOutcome,transport:network};
}
function safeAudit(x){try{return validateRegistrationAudit(x);}catch{return null;}}
const safeAuditPersistence=x=>['not-started','unconfirmed','confirmed'].includes(x)?x:'not-started';
// Bound every optional diagnostic/receipt sink. Safe in-memory state survives failure.
async function boundedSafeSink(action){let timer;try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(new SafeFailure('BOOTSTRAP_OUTCOME_UNKNOWN')),5000);})]);}catch{fail('BOOTSTRAP_OUTCOME_UNKNOWN');}finally{clearTimeout(timer);}}
function retainBootstrap(state,result,transport){
  state.bootstrapDiagnostic=safeBootstrapDiagnostic(result,transport);
  const audit=state.bootstrapDiagnostic.registrationAudit;
  if(audit&&(!state.registrationAudit||registrationAuditHash(state.registrationAudit)===registrationAuditHash(audit))){
    state.registrationAudit=audit;if(state.registrationAuditPersistence!=='confirmed')state.registrationAuditPersistence=state.bootstrapDiagnostic.registrationAuditPersistence;}
  if(state.registrationAudit){state.bootstrapDiagnostic.registrationAudit=state.registrationAudit;state.bootstrapDiagnostic.registrationAuditPersistence=state.registrationAuditPersistence;}
}
async function runStagedOperation(a,caps,{clock=Date,signal=new AbortController().signal,reserve,audit=async()=>{}}={}){
  const initial=a.stage==='initial-orders',index=initial?0:1;
  const state={status:'stopped',code:'READINESS_FAILED',stage:a.stage,maintenanceRequired:true,automaticMaintenanceResume:false,
    sideEffects:{bootstrap:'not-started',runPosts:0},confirmed:{ordersCalls:0,refreshCalls:0,secretVersions:0},registration:null,registrationAudit:null,registrationAuditPersistence:'not-started',
    binding:null,savedCredentialVersion:null,receipt:null,listenerClosed:true,bootstrapDiagnostic:null,controlDiagnostic:null,stageReserved:false};
  let app,meta=initial?null:a.binding,acceptSaved=initial,acceptDiagnostics=true;
  const cancel=()=>{void app?.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  const check=()=>{if(signal.aborted)fail('CANCELLED');if(clock.now()>=Date.parse(a.validUntilUtc))fail('DEADLINE_EXCEEDED');};
  const emit=async()=>boundedSafeSink(()=>audit(structuredClone(state)));
  const claim=async()=>{if(state.stageReserved)fail('STAGE_ALREADY_CLAIMED');check();await reserve();check();state.stageReserved=true;await emit();};
  try{
    if(a.spec!==FRESH.spec||a.operationId!==FRESH.operationId||a.authorizationId!==FRESH.authorizationId||a.stage!=='initial-orders'||JSON.stringify(a.requestIds)!==JSON.stringify([FRESH.requestId,FRESH.unusedRequestId])||typeof reserve!=='function')fail('APPROVAL_REQUIRED');
    check();
    if(!initial&&clock.now()<meta.expiresAt-120000)fail('REFRESH_WINDOW_NOT_REACHED');
    await caps.checkMaintenance(a.precedingVersion);check();
    if(initial){
      // Do not present owner consent unless its bounded admission/finalization and
      // first task can fit. This never extends the approved operation deadline.
      if(Date.parse(a.validUntilUtc)-clock.now()<960000)fail('WINDOW_OUTSIDE_APPROVAL');
      // Reuse reserves the new operation before UI; it never consumes a
      // registration reservation or reopens the historical operation claim.
      if(binding.existingClient)await claim();
      app=await caps.bootstrap({onBeforeRegistration:claim,onDiagnostic:async d=>{
        if(!acceptDiagnostics)return;retainBootstrap(state,d.result,d.transport);if(state.stageReserved)await emit();},onSaved:m=>{
        check();if(!acceptSaved||!state.stageReserved||meta||!exact(m,['clientId','expiresAt','versionName'])||!client(m.clientId)
          ||!Number.isSafeInteger(m.expiresAt)||m.expiresAt<=clock.now()||BigInt(versionOf(m.versionName))<=BigInt(a.precedingVersion))fail('CREDENTIAL_METADATA_INVALID');
        meta={clientId:m.clientId,expiresAt:m.expiresAt,versionName:versionName(versionOf(m.versionName))};
      }});check();
      state.listenerClosed=false;const start=await app.start();retainBootstrap(state,start,app.networkStatus?.());
      if(start.status==='pending'){state.registration=safeRegistration(start.registration);await emit();}
      const r=start.status==='pending'?await app.finished:start;acceptSaved=false;
      retainBootstrap(state,r,app.networkStatus?.());state.listenerClosed=r.listenerClosed===true;
      state.registration=safeRegistration(r.registration);
      if(!state.stageReserved||r.status!=='prepared-for-cloud-validation'||r.code!=='BOOTSTRAP_SECRET_VERSION_CONFIRMED'||!state.listenerClosed||!meta
        ||r.registration?.clientId!==meta.clientId||r.savedVersion?.state!=='ENABLED'||versionOf(r.savedVersion.name)!==versionOf(meta.versionName))fail('BOOTSTRAP_OUTCOME_UNKNOWN');
      state.sideEffects.bootstrap='confirmed';state.confirmed.secretVersions=1;state.binding=structuredClone(meta);state.savedCredentialVersion=meta.versionName;await emit();
    }else state.binding=structuredClone(meta);
    check();const bound=versionOf(meta.versionName);await caps.checkMaintenance(bound);check();
    const now=clock.now(),expires=Math.min(now+240000,Date.parse(a.validUntilUtc)-75000,nextDay(now)-1,initial?meta.expiresAt-125000:Number.MAX_SAFE_INTEGER);
    if(expires-now<80000)fail('WINDOW_OUTSIDE_APPROVAL');
    const request={requestId:a.requestIds[index],dataDate:day(now),expiresAt:new Date(expires).toISOString(),credentialBinding:{clientId:meta.clientId,version:bound}};
    if(!initial)await claim();
    state.sideEffects.runPosts=1;await emit();
    let run;try{run=await caps.probe(request,{index,signal,deadline:Math.min(Date.parse(a.validUntilUtc),now+300000)});}catch(error){
      const e=new SafeFailure('RUN_OUTCOME_UNKNOWN');e.controlDiagnostic=safeControlDiagnostic(error?.controlDiagnostic);throw e;}
    check();if(typeof run?.execution!=='string'||!new RegExp('^projects/'+FIXED.project+'/locations/'+FIXED.region+'/jobs/'+FIXED.job+'/executions/[a-z0-9-]+$').test(run.execution))fail('RECEIPT_INVALID');
    const r=validateReceipt(run.receipt,request,index,run.execution);
    state.receipt={...r,requestId:request.requestId,execution:run.execution};state.confirmed.ordersCalls=1;state.confirmed.refreshCalls=r.refreshCalls;
    if(!initial){state.confirmed.secretVersions=1;state.savedCredentialVersion=r.savedCredentialVersion;}
    await caps.checkMaintenance(versionOf(state.savedCredentialVersion));check();
    state.status=initial?'initial-orders-passed-refresh-pending':'natural-refresh-passed';state.code=initial?'INITIAL_ORDERS_PASSED_REFRESH_PENDING':'NATURAL_REFRESH_PASSED';await emit();
  }catch(error){try{if(typeof app?.snapshot==='function')retainBootstrap(state,app.snapshot(),app.networkStatus?.());}catch{}
    state.status='stopped';state.code=safeCode(error);state.controlDiagnostic=safeControlDiagnostic(error?.controlDiagnostic);
    if(initial&&state.stageReserved&&state.sideEffects.bootstrap!=='confirmed')state.sideEffects.bootstrap='outcome-unknown';
    if(state.stageReserved)try{await emit();}catch{};
  }finally{acceptSaved=false;acceptDiagnostics=false;signal.removeEventListener('abort',cancel);if(app)try{const end=await app.cancel();if(typeof end?.listenerClosed==='boolean')state.listenerClosed=end.listenerClosed;}catch{};try{await caps.close();}catch{}}
  return structuredClone(state);
}

function validateStageMaintenance(g,gh,a,expectedVersion,now){
  // EOD remains the separately approved independent proof. This transport still
  // reads zero EOD execution/context/nonce/argument/log/result resources.
  return validateMaintenance(g,gh,a,expectedVersion,now);
}

// Loaded only after all local approval/hash/privacy checks and an exclusive local claim.
// It is not a global cloud lock. External manual/EOD holds remain required.
const CONTROL_BRIDGE=String.raw`
import base64, concurrent.futures, datetime, hashlib, json, re, time, urllib.parse
P="family-portfolio-gateway"; R="asia-east2"; B=P+"-xuan-preopen-private"
SECRET="projects/"+P+"/secrets/xuan-preopen-ib-mcp"
JOB="projects/"+P+"/locations/"+R+"/jobs/xuan-preopen-orders-probe"
HASH="1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee"
ROOT="/Users/huanwu/Documents/Codex/2026-07-13/chatgpt-conversation-6a36247f-db60-83e8-b9c6/.tools/google-cloud-sdk"
JOBS=["xuan-preopen-orders-probe","xuan-preopen-report","xuan-preopen-report-check","xuan-preopen-source-check"]
EOD=["xuan-preopen-eod-flexfix-20261014","xuan-preopen-eod-acceptance-20261014"]
FIELDS="name,reconciling,template(taskCount,parallelism,template(serviceAccount,timeout,maxRetries,volumes,containers(image,command,args,env(name),volumeMounts,resources(limits))))"
class Closed(Exception): pass
ERROR_TYPES={
 ("builtins","RuntimeError"):("INTERNAL_ERROR","builtins.RuntimeError"),
 ("builtins","TimeoutError"):("READ_TIMEOUT","builtins.TimeoutError"),
 ("builtins","OSError"):("OS_ERROR","builtins.OSError"),
 ("builtins","PermissionError"):("FILE_ACCESS_ERROR","builtins.PermissionError"),
 ("builtins","FileNotFoundError"):("FILE_ACCESS_ERROR","builtins.FileNotFoundError"),
 ("builtins","UnicodeDecodeError"):("UNICODE_INVALID","builtins.UnicodeDecodeError"),
 ("json.decoder","JSONDecodeError"):("JSON_INVALID","json.decoder.JSONDecodeError"),
 ("requests.exceptions","ReadTimeout"):("READ_TIMEOUT","requests.exceptions.ReadTimeout"),
 ("requests.exceptions","ConnectTimeout"):("CONNECT_TIMEOUT","requests.exceptions.ConnectTimeout"),
 ("requests.exceptions","SSLError"):("TLS_ERROR","requests.exceptions.SSLError"),
 ("requests.exceptions","ConnectionError"):("CONNECTION_ERROR","requests.exceptions.ConnectionError"),
 ("requests.exceptions","Timeout"):("READ_TIMEOUT","requests.exceptions.Timeout"),
 ("google.auth.exceptions","RefreshError"):("GOOGLE_AUTH_ERROR","google.auth.exceptions.RefreshError"),
 ("google.auth.exceptions","TransportError"):("GOOGLE_AUTH_ERROR","google.auth.exceptions.TransportError"),
 ("googlecloudsdk.core.util.files","Error"):("FILE_ACCESS_ERROR","googlecloudsdk.core.util.files.Error")}
ORIGINS={"main","live_identity","call","session","unique","pairs","maintenance","job","version","executions_list","dispatch","run","operation","execution","receipt"}
def error_detail(error):
    if isinstance(error,Closed) and hasattr(error,"_control_detail"): return error._control_detail
    category,kind=("VALIDATION_REJECTED","Closed") if isinstance(error,Closed) else ERROR_TYPES.get((type(error).__module__,type(error).__name__),("INTERNAL_ERROR","unclassified"))
    origin="unknown"; line=None; tb=error.__traceback__
    while tb:
        if tb.tb_frame.f_code.co_filename==error_detail.__code__.co_filename and tb.tb_frame.f_code.co_name in ORIGINS:
            origin=tb.tb_frame.f_code.co_name; line=tb.tb_lineno
        tb=tb.tb_next
    return {"category":category,"exceptionType":kind,"origin":origin,"line":line,"httpStatus":None,"resource":"none"}
def resource_class(url):
    if url.startswith("https://cloudscheduler.googleapis.com/"): return "scheduler-state"
    if url.startswith("https://secretmanager.googleapis.com/"): return "secret-version-metadata"
    if url.startswith("https://storage.googleapis.com/"): return "safe-receipt"
    if "/operations/" in url: return "operation-status"
    if "/executions?" in url: return "run-state-list"
    if "/executions/" in url: return "execution-status"
    if url.endswith(":run"): return "run-start"
    return "job-config"
def failure_frame(stage,op,error):
    stage=stage if type(stage) is str and stage in {"init-frame","sdk-identity","transport-import","dispatch"} else "init-frame"
    op=op if type(op) is str and op in {"startup","identity","maintenance","run","operation","execution","receipt"} else "startup"
    return {"ok":False,"code":"CONTROL_FAILED","diagnostic":{"spec":"IB-ORDERS-CONTROL-DIAGNOSTIC-v1","stage":stage,"operation":op,**error_detail(error)}}
def unique(raw):
    def pairs(xs):
        d={}
        for k,v in xs:
            if k in d: raise Closed()
            d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(Closed()))
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
EXECUTION_DEADLINE_MS=None
def admit_sdk():
    if EXECUTION_DEADLINE_MS is not None and time.time()*1000>=EXECUTION_DEADLINE_MS: raise Closed()
def live_identity():
    admit_sdk()
    import sys
    sys.path[:0]=[ROOT+"/lib",ROOT+"/lib/third_party"]
    from googlecloudsdk.core import properties
    from googlecloudsdk.core.credentials import creds
    from google.oauth2.credentials import Credentials
    admit_sdk();account=properties.VALUES.core.account.Get();admit_sdk()
    if not isinstance(account,str) or hashlib.sha256(account.encode()).hexdigest()!=HASH: raise Closed()
    admit_sdk();store=creds.GetCredentialStore();admit_sdk();c=store.Load(account);admit_sdk()
    if not isinstance(c,Credentials): raise Closed()
    return account,c
class CachedGoogle:
    def __init__(self,credential):
        from google.auth.exceptions import RefreshError
        if credential.valid is not True: raise RefreshError()
        expiry=credential.expiry
        if not isinstance(expiry,datetime.datetime): raise Closed()
        if expiry.tzinfo is None: expiry=expiry.replace(tzinfo=datetime.timezone.utc)
        self.valid_until_ms=int(expiry.timestamp()*1000);self.credential=credential
    def before_request(self,request,method,url,headers):
        from google.auth.exceptions import RefreshError
        if self.credential.valid is not True: raise RefreshError()
        self.credential.apply(headers)
class Control:
    def __init__(self,account,credentials,session_factory,adapter_factory,request_factory,ids,deadline_ms=None):
        self.account=account; self.credentials=credentials; self.session_factory=session_factory
        self.adapter_factory=adapter_factory; self.request_factory=request_factory; self.ids=ids
        self.runs={}; self.operations={}; self.executions={}; self.deadline_ms=deadline_ms
    def admit(self):
        if self.deadline_ms is not None and time.time()*1000>=self.deadline_ms: raise Closed()
    def session(self):
        self.admit();s=self.session_factory(); s.trust_env=False; s.mount("https://",self.adapter_factory(max_retries=0)); return s
    def call(self,method,url,body=None,limit=65536):
        # Every call URL is constructed below from fixed names or a validated server receipt.
        s=self.session(); response=None
        try:
            headers={"accept":"application/json","content-type":"application/json"}
            self.admit();self.credentials.before_request(self.request_factory(session=s),method,url,headers)
            self.admit();response=s.request(method,url,json=body,headers=headers,timeout=(1,2.5),allow_redirects=False,stream=True)
            if response.status_code!=200 or response.url!=url: raise Closed()
            raw=bytearray()
            for chunk in response.iter_content(4096):
                raw.extend(chunk)
                if len(raw)>limit: raise Closed()
            return unique(raw.decode("utf-8",errors="strict")),bytes(raw)
        except BaseException as error:
            detail=dict(error_detail(error)); detail["resource"]=resource_class(url)
            if response is not None:
                status=response.status_code
                detail["httpStatus"]=status if type(status) is int and 100<=status<=599 else None
                if status!=200: detail["category"]="HTTP_REJECTED"
                elif response.url!=url: detail["category"]="RESPONSE_REJECTED"
            closed=Closed();closed._control_detail=detail;raise closed from None
        finally:
            if response is not None: response.close()
            s.close()
    def get(self,url): return self.call("GET",url)[0]
    def job(self,name):
        if name not in JOBS: raise Closed()
        return self.get("https://run.googleapis.com/v2/projects/"+P+"/locations/"+R+"/jobs/"+name+"?fields="+urllib.parse.quote(FIELDS,safe=""))
    def version(self):
        vs=[]; token=None; seen=set()
        for _ in range(20):
            url="https://secretmanager.googleapis.com/v1/"+SECRET+"/versions?pageSize=100&fields=versions(name,state),nextPageToken"
            if token: url+="&pageToken="+urllib.parse.quote(token,safe="")
            d=self.get(url)
            for v in d.get("versions",[]):
                if not re.fullmatch(r"projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/[1-9][0-9]{0,29}",v.get("name","")): raise Closed()
                vs.append((int(v["name"].rsplit("/",1)[1]),v.get("state")))
            token=d.get("nextPageToken")
            if not token: break
            if token in seen: raise Closed()
            seen.add(token)
        else: raise Closed()
        if not vs or len(set(v[0] for v in vs))!=len(vs): raise Closed()
        n,state=max(vs); return {"version":str(n),"state":state}
    def executions_list(self,name):
        total=running=0; token=None; seen=set()
        for _ in range(20):
            url="https://run.googleapis.com/v2/projects/"+P+"/locations/"+R+"/jobs/"+name+"/executions?pageSize=100&fields=executions(completionTime,runningCount),nextPageToken"
            if token: url+="&pageToken="+urllib.parse.quote(token,safe="")
            d=self.get(url)
            for e in d.get("executions",[]):
                if not e.get("completionTime"): total+=1
                count=e.get("runningCount",0)
                if type(count) is not int or count<0: raise Closed()
                running+=count
            token=d.get("nextPageToken")
            if not token: return {"name":name,"unfinished":total,"running":running,"complete":True}
            if token in seen: raise Closed()
            seen.add(token)
        raise Closed()
    def maintenance(self):
        def scheduler(n):
            d=self.get("https://cloudscheduler.googleapis.com/v1/projects/"+P+"/locations/"+R+"/jobs/"+n+"?fields=name,state")
            if d.get("name")!="projects/"+P+"/locations/"+R+"/jobs/"+n: raise Closed()
            return {"name":n,"state":d.get("state")}
        # EOD execution/context/nonce is deliberately outside this transport.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            js=[pool.submit(self.executions_list,n) for n in JOBS]
            ss=[pool.submit(scheduler,n) for n in ["xuan-preopen-clock","xuan-preopen-start-watch"]]
            p=pool.submit(self.job,"xuan-preopen-orders-probe"); v=pool.submit(self.version)
            return {"complete":True,"observedAtUtc":stamp(),"identityMatched":True,"jobs":[j.result() for j in js],
              "schedulers":[s.result() for s in ss],"probe":p.result(),"secret":v.result(),"eodJobNames":EOD,"eodExecutionReads":0}
    def run(self,req):
        if type(req) is not dict or set(req)!={"requestId","dataDate","expiresAt","credentialBinding"}: raise Closed()
        rid=req["requestId"]; ix=len(self.runs)
        if ix>=2 or rid!=self.ids[ix] or rid in self.runs: raise Closed()
        b=req["credentialBinding"]
        if type(b) is not dict or set(b)!={"clientId","version"} or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}",b.get("clientId","")) or not re.fullmatch(r"[1-9][0-9]{0,29}",b.get("version","")): raise Closed()
        # Claim before HTTP: a lost response is never a reason to resend.
        self.runs[rid]=True
        d=self.call("POST","https://run.googleapis.com/v2/"+JOB+":run",{"overrides":{"containerOverrides":[{"args":["--request",json.dumps(req,separators=(",",":"))]}],"taskCount":1,"timeout":"75s"}})[0]
        op=d.get("name","")
        if not re.fullmatch(r"projects/family-portfolio-gateway/locations/asia-east2/operations/[A-Za-z0-9_-]+",op): raise Closed()
        self.operations[op]=rid
        return {"operation":op}
    def operation(self,op):
        if op not in self.operations: raise Closed()
        d=self.get("https://run.googleapis.com/v2/"+op+"?fields=name,done,error(code),response(name),metadata(name)")
        if d.get("name")!=op or d.get("error"): raise Closed()
        name=d.get("response",{}).get("name") or d.get("metadata",{}).get("name")
        if name:
            if not re.fullmatch(re.escape(JOB)+r"/executions/[a-z0-9-]+",name): raise Closed()
            self.executions[name]=self.operations[op]
        return {"done":d.get("done",False),"execution":name}
    def execution(self,name):
        if name not in self.executions: raise Closed()
        d=self.get("https://run.googleapis.com/v2/"+name+"?fields=name,completionTime,succeededCount,failedCount,cancelledCount,runningCount")
        if d.get("name")!=name: raise Closed()
        return d
    def receipt(self,name):
        if name not in self.executions: raise Closed()
        rid=self.executions[name]; obj="report-check/orders-probe-"+rid+"/receipt.json"
        d,raw=self.call("GET","https://storage.googleapis.com/download/storage/v1/b/"+B+"/o/"+urllib.parse.quote(obj,safe="")+"?alt=media")
        fields=["mode","status","requestId","dataDate","expiresAt","execution","startedAt","completedAt","upstreamAttempted","ordersCalls","refreshCalls","credentialPersistence","consumedCredentialVersion","savedCredentialVersion","credentialClientMatched","credentialVersionMatched","associationBasis","responseAccountEvidence","nativeIdentityEvidence"]
        return {**{k:d[k] for k in fields if k in d},"receiptSha256":hashlib.sha256(raw).hexdigest()}
    def dispatch(self,m):
        self.admit()
        op=m.get("op")
        if op=="identity" and set(m)=={"op"}:
            result={"operatorAccount":self.account}
            if isinstance(self.credentials,CachedGoogle): result["cachedGoogleValidUntilMs"]=self.credentials.valid_until_ms
            return result
        if op=="maintenance" and set(m)=={"op"}: return self.maintenance()
        if op=="run" and set(m)=={"op","request"}: return self.run(m["request"])
        if op=="operation" and set(m)=={"op","operation"}: return self.operation(m["operation"])
        if op=="execution" and set(m)=={"op","execution"}: return self.execution(m["execution"])
        if op=="receipt" and set(m)=={"op","execution"}: return self.receipt(m["execution"])
        raise Closed()
def main():
    global EXECUTION_DEADLINE_MS
    import os,sys,logging,http.client
    out=os.dup(1)
    with open(os.devnull,"wb") as sink: os.dup2(sink.fileno(),1); os.dup2(sink.fileno(),2)
    logging.disable(logging.CRITICAL); http.client.HTTPConnection.debuglevel=0
    stage="init-frame"
    try:
        init=unique(sys.stdin.buffer.readline(65537).decode("utf-8")); ids=init["requestIds"]
        if set(init) not in ({"requestIds"},{"requestIds","cachedOnly"},{"requestIds","cachedOnly","deadlineMs"}) or ("cachedOnly" in init and init["cachedOnly"] is not True) or len(ids)!=2 or len(set(ids))!=2 or any(not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",x) for x in ids): raise Closed()
        deadline=init.get("deadlineMs")
        if deadline is not None and (type(deadline) is not int or deadline<=0 or deadline>9007199254740991 or time.time()*1000>=deadline): raise Closed()
        EXECUTION_DEADLINE_MS=deadline
        stage="sdk-identity";account,credential=live_identity()
        if init.get("cachedOnly") is True: credential=CachedGoogle(credential)
        if deadline is not None and time.time()*1000>=deadline: raise Closed()
        stage="transport-import"
        from requests import Session
        from requests.adapters import HTTPAdapter
        from google.auth.transport.requests import Request
        control=Control(account,credential,Session,HTTPAdapter,Request,ids,deadline)
        for raw in sys.stdin.buffer:
            if len(raw)>65536: raise Closed()
            op="startup";stage="dispatch"
            try:
                message=unique(raw.decode("utf-8"));candidate=message.get("op") if isinstance(message,dict) else None
                if type(candidate) is not str or candidate not in {"identity","maintenance","run","operation","execution","receipt"}: raise Closed()
                op=candidate
                result={"ok":True,"value":control.dispatch(message)}
            except BaseException as error: result=failure_frame(stage,op,error)
            os.write(out,(json.dumps(result,separators=(",",":"))+"\n").encode())
    except BaseException as error: os.write(out,(json.dumps(failure_frame(stage,"startup",error),separators=(",",":"))+"\n").encode()); return 1
    finally: os.close(out)
    return 0
if __name__=="__main__": raise SystemExit(main())
`;


return {FIXED,FRESH,SOURCE_HASHES,freshClaimRecord,safeJson,safeControlDiagnostic,boundedSafeSink,runStagedOperation,executionAdmission,createObservedOAuthFetch,safeBootstrapDiagnostic,SafeFailure,validateStageMaintenance,versionOf,versionName,validateJob,validateMaintenance,validateReceipt,CONTROL_BRIDGE,validateRegistrationAudit,registrationAuditHash};
}
