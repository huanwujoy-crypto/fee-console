// IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1. Import/CLI defaults are strictly offline.
import crypto from 'node:crypto';
import {uniqueCloudJson,validateIbRotationReceipt,validateBoundIbVersionName} from '../cloud/xuan-preopen/cloud_io.mjs';
import {assessRegistration,registrationAuditHash,registrationRequestProfile} from './xuan-ib-oauth-registration-audit.mjs';

export const BOOTSTRAP_SPEC='IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1';
export const BOOTSTRAP=Object.freeze({issuer:'https://api.ibkr.com',register:'https://api.ibkr.com/oauth2/register',
  authorize:'https://api.ibkr.com/oauth2/authorize',token:'https://api.ibkr.com/oauth2/api/v1/token',
  resource:'https://api.ibkr.com/v1/api/mcp-public',project:'family-portfolio-gateway',
  secret:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp',job:'xuan-preopen-orders-probe',
  sourceSa:'xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com',bucket:'family-portfolio-gateway-xuan-preopen-private',
  clientName:'XUAN Preopen Cloud Read-only v2',scope:'mcp.read',callbackPath:'/oauth/ib/callback',startPath:'/oauth/ib/start',
  ttlMs:600000,finalizeMs:40000,maintenanceMs:5000,auditMs:5000,httpMs:15000,writerMs:20000,maxResponseBytes:65536,
  sdkRoot:'/Users/huanwu/Documents/Codex/2026-07-13/chatgpt-conversation-6a36247f-db60-83e8-b9c6/.tools/google-cloud-sdk',
  python:'/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12',
  operatorAccountSha256:'1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee'});
const CODES=new Set(['OFFLINE_PREPARATION_ONLY','BOOTSTRAP_REQUEST_INVALID','BOOTSTRAP_APPROVAL_REQUIRED',
  'BOOTSTRAP_PROFILE_REVIEW_REQUIRED','BOOTSTRAP_REGISTRATION_AUDIT_UNCONFIRMED','BOOTSTRAP_LISTENER_BINDING_INVALID','BOOTSTRAP_CALLBACK_INVALID',
  'BOOTSTRAP_SESSION_EXPIRED','BOOTSTRAP_FINALIZATION_EXPIRED','BOOTSTRAP_CANCELLED','BOOTSTRAP_REPLAY_REJECTED','BOOTSTRAP_OWNER_AUTHORIZATION_REJECTED',
  'BOOTSTRAP_DCR_REJECTED','BOOTSTRAP_DCR_OUTCOME_UNKNOWN','BOOTSTRAP_EXCHANGE_REJECTED','BOOTSTRAP_EXCHANGE_OUTCOME_UNKNOWN',
  'BOOTSTRAP_TOKEN_INVALID','BOOTSTRAP_MAINTENANCE_UNCONFIRMED','BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN',
  'BOOTSTRAP_SECRET_ACK_INVALID','BOOTSTRAP_INTERNAL_FAILED','BOOTSTRAP_AWAITING_OWNER','BOOTSTRAP_SECRET_VERSION_CONFIRMED']);
class SafeError extends Error{constructor(code){super(CODES.has(code)?code:'BOOTSTRAP_INTERNAL_FAILED');}}
const fail=code=>{throw new SafeError(code);};
export const bootstrapFailure=code=>new SafeError(code);
const safeCode=e=>e instanceof SafeError&&CODES.has(e.message)?e.message:'BOOTSTRAP_INTERNAL_FAILED';
const object=o=>o&&Object.getPrototypeOf(o)===Object.prototype;
const sameKeys=(o,keys)=>object(o)&&Object.keys(o).sort().join('|')===[...keys].sort().join('|')
  &&Object.values(Object.getOwnPropertyDescriptors(o)).every(d=>Object.hasOwn(d,'value'));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const clientId=s=>typeof s==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(s);
const version=s=>typeof s==='string'&&/^[1-9]\d{0,29}$/.test(s);
const exactSet=(a,expected)=>Array.isArray(a)&&a.length===expected.length&&new Set(a).size===a.length&&expected.every(v=>a.includes(v));
const defaultClock=Object.freeze({now:Date.now,setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:t=>clearTimeout(t)});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)
  &&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));

export function validateLoopbackUri(value){
  let u;try{u=new URL(value);}catch{fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}
  if(typeof value!=='string'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||Number(u.port)<1||Number(u.port)>65535
    ||u.pathname!==BOOTSTRAP.callbackPath||u.search||u.hash||u.username||u.password
    ||value!==`http://127.0.0.1:${u.port}${BOOTSTRAP.callbackPath}`)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
  return u;
}
export const registrationProfile=registrationRequestProfile;

function registrationReceipt(audit,{redirectUri,codeSha256,now}){
  if(!audit.profileAccepted)fail('BOOTSTRAP_PROFILE_REVIEW_REQUIRED');
  return Object.freeze({spec:BOOTSTRAP_SPEC,clientId:audit.clientId,requestedClientName:BOOTSTRAP.clientName,displayNameEvidence:audit.displayNameEvidence,redirectUri,
    tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],scope:'mcp.read',
    issuer:BOOTSTRAP.issuer,resource:BOOTSTRAP.resource,observedAtUtc:new Date(now()).toISOString(),
    issuerEvidence:'fixed-endpoint',resourceEvidence:'explicit-request-only',
    timestampEvidence:'local-registration-response-received',codeSha256,
    managementCredentialReturned:audit.managementCredentialReturned,managementCredentialPersisted:false});
}
function credentialFromToken(raw,{registeredClientId,now}){
  if(!object(raw)||typeof raw.access_token!=='string'||!raw.access_token.trim()||typeof raw.refresh_token!=='string'||!raw.refresh_token.trim()
    ||typeof raw.token_type!=='string'||raw.token_type.toLowerCase()!=='bearer'||!Number.isFinite(raw.expires_in)||raw.expires_in<=0||raw.expires_in>31536000
    ||raw.scope!==undefined&&raw.scope!=='mcp.read'||raw.client_id!==undefined&&raw.client_id!==registeredClientId
    ||raw.resource!==undefined&&raw.resource!==BOOTSTRAP.resource||Object.hasOwn(raw,'id_token'))fail('BOOTSTRAP_TOKEN_INVALID');
  const expiresAt=now()+raw.expires_in*1000;if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())fail('BOOTSTRAP_TOKEN_INVALID');
  return {credential:{client_id:registeredClientId,access_token:raw.access_token,refresh_token:raw.refresh_token,
    token_type:'Bearer',scope:'mcp.read',resource:BOOTSTRAP.resource,expires_at:expiresAt},
    scopeEvidence:raw.scope===undefined?'explicit-request-inherited':'token-response',audienceEvidence:'requested-resource-only'};
}
async function boundedJson(response,signal){
  if(!response?.body)fail('BOOTSTRAP_INTERNAL_FAILED');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>BOOTSTRAP.maxResponseBytes)fail('BOOTSTRAP_INTERNAL_FAILED');chunks.push(Buffer.from(value));}}
  finally{void reader.cancel().catch(()=>{});}
  return uniqueCloudJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),BOOTSTRAP.maxResponseBytes);
}
async function oauthPost(endpoint,body,{fetchImpl,clock,signal,phase}){
  if(![BOOTSTRAP.register,BOOTSTRAP.token].includes(endpoint))fail('BOOTSTRAP_REQUEST_INVALID');
  const timeout=new AbortController(),combined=AbortSignal.any([signal,timeout.signal]);
  let timer;const unknown=phase==='register'?'BOOTSTRAP_DCR_OUTCOME_UNKNOWN':'BOOTSTRAP_EXCHANGE_OUTCOME_UNKNOWN';
  const rejected=phase==='register'?'BOOTSTRAP_DCR_REJECTED':'BOOTSTRAP_EXCHANGE_REJECTED';
  const expiry=new Promise((_,reject)=>{timer=clock.setTimeout(()=>{timeout.abort();reject(new SafeError(unknown));},BOOTSTRAP.httpMs);});
  const action=(async()=>{let response;
    try{combined.throwIfAborted();response=await fetchImpl(endpoint,{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',signal:combined,
      headers:{'content-type':phase==='register'?'application/json':'application/x-www-form-urlencoded','accept':'application/json'},body});}
    catch{fail(unknown);}
    if(response.redirected||response.url&&response.url!==endpoint)fail(unknown);
    if(!response.ok)fail(response.status>=400&&response.status<500?rejected:unknown);
    try{const value=await boundedJson(response,combined);return phase==='register'?{body:value,httpStatus:response.status}:value;}catch{fail(unknown);}
  })();
  try{return await Promise.race([action,expiry]);}finally{clock.clearTimeout(timer);}
}
function validateApproval(a,operatorAccountSha256=BOOTSTRAP.operatorAccountSha256){
  if(!sameKeys(a,['spec','codeSha256','redirectUri','operatorAccount','precedingVersion','approved','acceptMacReplacement'])
    ||a.spec!==BOOTSTRAP_SPEC||a.approved!==true||a.acceptMacReplacement!==true||! /^[a-f0-9]{64}$/.test(a.codeSha256||'')
    ||typeof a.operatorAccount!=='string'||! /^[A-Za-z0-9._%+@-]{3,200}$/.test(a.operatorAccount)
    ||! /^[a-f0-9]{64}$/.test(operatorAccountSha256)||sha(a.operatorAccount)!==operatorAccountSha256
    ||!version(a.precedingVersion))fail('BOOTSTRAP_APPROVAL_REQUIRED');
  validateLoopbackUri(a.redirectUri);return Object.freeze({...a});
}
async function verifyMaintenance(adapter,precedingVersion,{clock,signal}){
  let proof,timer,onAbort;
  try{
    if(signal.aborted)fail('BOOTSTRAP_MAINTENANCE_UNCONFIRMED');
    const bounded=new Promise((_,reject)=>{
      onAbort=()=>reject(new SafeError('BOOTSTRAP_MAINTENANCE_UNCONFIRMED'));
      signal.addEventListener('abort',onAbort,{once:true});
      timer=clock.setTimeout(onAbort,BOOTSTRAP.maintenanceMs);
    });
    proof=await Promise.race([adapter?.check({secret:BOOTSTRAP.secret,expectedVersion:precedingVersion}),bounded]);
  }catch{fail('BOOTSTRAP_MAINTENANCE_UNCONFIRMED');}
  finally{clock.clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
  if(!sameKeys(proof,['entrypointsPaused','executionsDrained','manualOldVersionRunsBlocked','observedVersion'])
    ||proof.entrypointsPaused!==true||proof.executionsDrained!==true||proof.manualOldVersionRunsBlocked!==true
    ||proof.observedVersion!==precedingVersion)fail('BOOTSTRAP_MAINTENANCE_UNCONFIRMED');
}

export async function preflightLoopback({listener}={}){
  // Future explicit preflight only; not invoked by import, CLI, or tests with a real adapter.
  let bound;try{bound=await listener.bind({host:'127.0.0.1',port:0});
    if(bound.host!=='127.0.0.1'||!Number.isInteger(bound.port)||bound.port<1||bound.port>65535)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
    const redirectUri=`http://127.0.0.1:${bound.port}${BOOTSTRAP.callbackPath}`;validateLoopbackUri(redirectUri);
    return {status:'preflight-only',redirectUri,listenerClosed:true,registrationStarted:false,codeExchangeStarted:false};
  }catch{fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}finally{try{await bound?.close();}catch{fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}}
}

export function createBootstrap({approval,fetchImpl,listener,browser,store,maintenance,registrationContext,onRegistrationAudit,clock=defaultClock,randomBytes=crypto.randomBytes,
  operatorAccountSha256=BOOTSTRAP.operatorAccountSha256,admission=()=>{}}={}){
  const approved=validateApproval(approval,operatorAccountSha256);
  if(typeof admission!=='function'||typeof fetchImpl!=='function'||typeof listener?.bind!=='function'||typeof browser?.open!=='function'||typeof store?.save!=='function'
    ||typeof maintenance?.check!=='function'||typeof onRegistrationAudit!=='function'||!sameKeys(registrationContext,['attemptId','operationId','approvalSha256']))fail('BOOTSTRAP_APPROVAL_REQUIRED');
  try{assessRegistration({}, {...registrationContext,codeSha256:approved.codeSha256,redirectUri:approved.redirectUri,observedAtUtc:new Date(clock.now()).toISOString(),httpStatus:201});}
  catch{fail('BOOTSTRAP_APPROVAL_REQUIRED');}
  registrationContext=Object.freeze({...registrationContext});
  let phase='prepared',bound=null,bindPending=null,closePending=null,started=false,used=false,startUsed=false,stopped=false,listenerClosed=true,timer,deadline=0,finalDeadline=0,receipt=null,scopeEvidence=null;
  let sensitive=null;const controller=new AbortController();
  const effects={registration:'not-started',codeExchange:'not-started',secretWrite:'not-started'};
  let registrationAudit=null,registrationAuditPersistence='not-started';
  let terminal=null,savedVersion=null,resolveFinished,lastCode='BOOTSTRAP_AWAITING_OWNER',lastStatus='pending';const finished=new Promise(resolve=>{resolveFinished=resolve;});
  const snapshot=(code,status='pending')=>({status,code,phase,sideEffects:{...effects},registration:receipt,
    scopeEvidence,savedVersion,listenerClosed,registrationAudit,registrationAuditPersistence,automaticRetry:false,nativeAccountProof:false});
  const close=async()=>{stopped=true;clock.clearTimeout(timer);controller.abort();sensitive=null;
    // A cancelled bind may resolve late. Wait for ownership before closing it.
    if(bindPending){try{await bindPending;}catch{listenerClosed=true;}}
    if(bound&&!closePending){closePending=(async()=>{try{await bound.close();listenerClosed=true;}catch{listenerClosed=false;}})();}
    if(closePending)await closePending;
  };
  const finish=async(code,status='failed')=>{terminal??={code,status};lastCode=terminal.code;lastStatus=terminal.status;await close();
    const result=snapshot(terminal.code,terminal.status);resolveFinished(result);return result;};
  const alive=()=>{admission();if(stopped||clock.now()>=(used?finalDeadline:deadline))fail(used?'BOOTSTRAP_FINALIZATION_EXPIRED':'BOOTSTRAP_SESSION_EXPIRED');};
  const reject=async error=>{phase='stopped';return finish(safeCode(error));};
  const random=()=>{const bytes=randomBytes(32);if(!Buffer.isBuffer(bytes)||bytes.length!==32)fail('BOOTSTRAP_INTERNAL_FAILED');return bytes.toString('base64url');};
  const validateRequest=req=>{
    if(!object(req)||req.method!=='GET'||req.host!==new URL(approved.redirectUri).host||req.hostCount!==1
      ||typeof req.rawUrl!=='string'||!req.rawUrl.startsWith('/')||req.rawUrl.startsWith('//')||req.rawUrl.length>8192||/[\r\n\0#]/.test(req.rawUrl))fail('BOOTSTRAP_CALLBACK_INVALID');
    const url=new URL(req.rawUrl,new URL(approved.redirectUri).origin);
    if(url.origin!==new URL(approved.redirectUri).origin)fail('BOOTSTRAP_CALLBACK_INVALID');return url;
  };
  const handleHttp=async req=>{
    if(used)return {statusCode:409,body:'Authorization response already consumed.',safe:snapshot('BOOTSTRAP_REPLAY_REJECTED','failed')};
    try{
      alive();const url=validateRequest(req);
      if(url.pathname===BOOTSTRAP.startPath){
        if(url.search||startUsed||phase!=='await-owner')fail('BOOTSTRAP_CALLBACK_INVALID');startUsed=true;
        const authorization=new URL(BOOTSTRAP.authorize);
        for(const [k,v] of Object.entries({response_type:'code',client_id:receipt.clientId,redirect_uri:approved.redirectUri,scope:'mcp.read',resource:BOOTSTRAP.resource,
          state:sensitive.state,code_challenge:crypto.createHash('sha256').update(sensitive.verifier).digest('base64url'),code_challenge_method:'S256'}))authorization.searchParams.set(k,v);
        return {statusCode:303,headers:{Location:authorization.href,'Set-Cookie':`xuan_ib_session=${sensitive.cookie}; HttpOnly; SameSite=Lax; Path=${BOOTSTRAP.callbackPath}; Max-Age=${Math.max(0,Math.floor((deadline-clock.now())/1000))}`},body:'Continue in your browser.'};
      }
      if(url.pathname!==BOOTSTRAP.callbackPath||!startUsed||phase!=='await-owner')fail('BOOTSTRAP_CALLBACK_INVALID');
      const seen=new Set();for(const [key] of url.searchParams){if(seen.has(key)||!['code','state','iss','error','error_description','error_uri'].includes(key))fail('BOOTSTRAP_CALLBACK_INVALID');seen.add(key);}
      const p=url.searchParams,cookies=typeof req.cookie==='string'?req.cookie.split(';').map(s=>s.trim()).filter(s=>s.startsWith('xuan_ib_session=')):[];
      if(cookies.length!==1||!equal(cookies[0].slice('xuan_ib_session='.length),sensitive.cookie)||p.get('iss')!==BOOTSTRAP.issuer
        ||!equal(p.get('state'),sensitive.state)||p.has('code')===p.has('error'))fail('BOOTSTRAP_CALLBACK_INVALID');
      if(p.has('error')){used=true;phase='stopped';return {statusCode:400,body:'Authorization not completed.',safe:await finish('BOOTSTRAP_OWNER_AUTHORIZATION_REJECTED')};}
      const code=p.get('code');if(typeof code!=='string'||! /^[\x21-\x7e]{1,4096}$/.test(code))fail('BOOTSTRAP_CALLBACK_INVALID');
      // Synchronous compare-and-consume precedes every await: one code exchange.
      used=true;phase='exchange';effects.codeExchange='unknown';
      // Ten minutes limits admission only. An accepted code gets one bounded
      // 40-second finish window: exchange <=15s, maintenance <=5s, write <=20s.
      clock.clearTimeout(timer);finalDeadline=clock.now()+BOOTSTRAP.finalizeMs;
      timer=clock.setTimeout(()=>{phase='finalization-expired';void finish('BOOTSTRAP_FINALIZATION_EXPIRED');},BOOTSTRAP.finalizeMs);
      const token=await oauthPost(BOOTSTRAP.token,new URLSearchParams({grant_type:'authorization_code',client_id:receipt.clientId,code,
        redirect_uri:approved.redirectUri,code_verifier:sensitive.verifier,scope:'mcp.read',resource:BOOTSTRAP.resource}),
        {fetchImpl,clock,signal:controller.signal,phase:'exchange'});
      effects.codeExchange='confirmed';alive();
      const next=credentialFromToken(token,{registeredClientId:receipt.clientId,now:clock.now});scopeEvidence=next.scopeEvidence;
      phase='maintenance-check';await verifyMaintenance(maintenance,approved.precedingVersion,{clock,signal:controller.signal});alive();
      phase='secret-write';effects.secretWrite='unknown';
      let ack,writeTimer;const writeController=new AbortController();
      try{ack=await Promise.race([store.save(next.credential,{signal:AbortSignal.any([controller.signal,writeController.signal]),operatorAccount:approved.operatorAccount,
        precedingVersion:approved.precedingVersion}),new Promise((_,reject)=>{writeTimer=clock.setTimeout(()=>{writeController.abort();reject(new SafeError('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN'));},BOOTSTRAP.writerMs);})]);}
      catch{fail('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN');}finally{clock.clearTimeout(writeTimer);}
      alive();
      try{ack=validateIbRotationReceipt(ack);if(BigInt(ack.name.split('/').at(-1))<=BigInt(approved.precedingVersion))throw Error('ack');}
      catch{fail('BOOTSTRAP_SECRET_ACK_INVALID');}
      effects.secretWrite='confirmed';savedVersion={name:ack.name,state:ack.state};phase='completed';
      return {statusCode:200,body:'Credential version saved. Cloud validation remains pending.',safe:await finish('BOOTSTRAP_SECRET_VERSION_CONFIRMED','prepared-for-cloud-validation')};
    }catch(error){const code=safeCode(error);if(code==='BOOTSTRAP_DCR_REJECTED')effects.registration='rejected';if(code==='BOOTSTRAP_EXCHANGE_REJECTED')effects.codeExchange='rejected';
      return {statusCode:400,body:'Authorization stopped. Review the safe status.',safe:await reject(error)};}
  };
  const start=async()=>{
    if(started||stopped)return snapshot('BOOTSTRAP_REPLAY_REJECTED','failed');started=true;deadline=clock.now()+BOOTSTRAP.ttlMs;
    try{
      sensitive={state:random(),verifier:random(),cookie:random()};
      if(new Set(Object.values(sensitive)).size!==3)fail('BOOTSTRAP_INTERNAL_FAILED');
      timer=clock.setTimeout(()=>{phase='expired';void finish('BOOTSTRAP_SESSION_EXPIRED');},BOOTSTRAP.ttlMs);
      phase='listen';const uri=validateLoopbackUri(approved.redirectUri);
      listenerClosed=false;
      bindPending=Promise.resolve().then(()=>listener.bind({host:'127.0.0.1',port:Number(uri.port),signal:controller.signal,admission:alive})).then(resource=>{bound=resource;return resource;});
      await bindPending;
      alive();
      if(bound.host!=='127.0.0.1'||bound.port!==Number(uri.port)||`http://${bound.host}:${bound.port}${BOOTSTRAP.callbackPath}`!==approved.redirectUri)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
      alive();await verifyMaintenance(maintenance,approved.precedingVersion,{clock,signal:controller.signal});alive();
      phase='register';effects.registration='unknown';
      const response=await oauthPost(BOOTSTRAP.register,JSON.stringify(registrationProfile(approved.redirectUri)),{fetchImpl,clock,signal:controller.signal,phase:'register'});
      effects.registration='confirmed';
      registrationAudit=assessRegistration(response.body,{...registrationContext,codeSha256:approved.codeSha256,redirectUri:approved.redirectUri,
        observedAtUtc:new Date(clock.now()).toISOString(),httpStatus:response.httpStatus});
      registrationAuditPersistence='unconfirmed';let auditTimer,onAuditAbort;const auditController=new AbortController();
      const auditSignal=AbortSignal.any([controller.signal,auditController.signal]);
      try{const ack=await Promise.race([onRegistrationAudit(registrationAudit,{signal:auditSignal}),new Promise((_,reject)=>{
        onAuditAbort=()=>reject(new SafeError('BOOTSTRAP_REGISTRATION_AUDIT_UNCONFIRMED'));
        controller.signal.addEventListener('abort',onAuditAbort,{once:true});
        auditTimer=clock.setTimeout(()=>{auditController.abort();onAuditAbort();},BOOTSTRAP.auditMs);})]);
        if(!sameKeys(ack,['persisted','auditSha256'])||ack.persisted!==true||ack.auditSha256!==registrationAuditHash(registrationAudit))throw Error();
        alive();registrationAuditPersistence='confirmed';
      }catch{fail('BOOTSTRAP_REGISTRATION_AUDIT_UNCONFIRMED');}finally{clock.clearTimeout(auditTimer);controller.signal.removeEventListener('abort',onAuditAbort);}
      receipt=registrationReceipt(registrationAudit,{redirectUri:approved.redirectUri,codeSha256:approved.codeSha256,now:clock.now});alive();
      phase='await-owner';bound.setHandler(handleHttp);
      // Only the non-sensitive loopback start URL reaches a browser adapter.
      // That same browser receives an HttpOnly session cookie before redirect.
      await browser.open(new URL(BOOTSTRAP.startPath,approved.redirectUri).href,{signal:controller.signal,admission:alive});alive();
      return snapshot('BOOTSTRAP_AWAITING_OWNER');
    }catch(error){if(safeCode(error)==='BOOTSTRAP_DCR_REJECTED')effects.registration='rejected';return reject(error);}
  };
  return Object.freeze({start,handleHttp,finished,snapshot:()=>snapshot(lastCode,lastStatus),cancel:async()=>{phase='cancelled';return finish('BOOTSTRAP_CANCELLED');}});
}

// These factories are inert. Tests use fakes; no factory is invoked by CLI.
// SDK is used only to load the pinned stored user identity. Secret Manager uses
// one direct HTTPS POST with transport retries and redirects disabled. Never use
// gcloud's generated addVersion client: its internal retry policy is unsuitable.
export const SDK_BRIDGE_CODE=String.raw`
import base64, hashlib, json, re
SECRET = "projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp"
URL = "https://secretmanager.googleapis.com/v1/" + SECRET + ":addVersion"
OPERATOR_HASH = "1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee"
SDK_ROOT = "/Users/huanwu/Documents/Codex/2026-07-13/chatgpt-conversation-6a36247f-db60-83e8-b9c6/.tools/google-cloud-sdk"
class BridgeFailure(Exception):
    def __init__(self):
        super().__init__("BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN")
def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise BridgeFailure()
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(BridgeFailure()))
def submit(credential, identity_loader, session_factory, adapter_factory, request_factory, operator_hash=OPERATOR_HASH):
    response = session = None
    try:
        keys = {"client_id", "access_token", "refresh_token", "token_type", "scope", "resource", "expires_at"}
        if type(credential) is not dict or set(credential) != keys:
            raise BridgeFailure()
        if not isinstance(credential["client_id"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", credential["client_id"]):
            raise BridgeFailure()
        if any(not isinstance(credential[k], str) or not credential[k].strip() for k in ("access_token", "refresh_token")):
            raise BridgeFailure()
        if credential["token_type"] != "Bearer" or credential["scope"] != "mcp.read" or credential["resource"] != "https://api.ibkr.com/v1/api/mcp-public":
            raise BridgeFailure()
        if type(credential["expires_at"]) is not int or not 0 < credential["expires_at"] <= 9007199254740991:
            raise BridgeFailure()
        account, credentials = identity_loader()
        if not isinstance(account, str) or hashlib.sha256(account.encode()).hexdigest() != operator_hash:
            raise BridgeFailure()
        session = session_factory()
        # No netrc, environment credentials, proxy override, or implicit auth.
        session.trust_env = False
        session.mount("https://", adapter_factory(max_retries=0))
        headers = {"content-type": "application/json", "accept": "application/json"}
        # SDK user credentials may refresh before this POST. There is no
        # AuthorizedSession and therefore no post-401 authentication resend.
        credentials.before_request(request_factory(session=session), "POST", URL, headers)
        if not isinstance(headers.get("authorization"), str) or not headers["authorization"].startswith("Bearer "):
            raise BridgeFailure()
        payload = base64.b64encode(json.dumps(credential, separators=(",", ":")).encode()).decode()
        response = session.post(URL, json={"payload": {"data": payload}}, headers=headers,
                                timeout=(5, 12), allow_redirects=False, stream=True)
        if response.status_code != 200 or response.url != URL:
            raise BridgeFailure()
        raw = bytearray()
        for chunk in response.iter_content(chunk_size=4096):
            raw.extend(chunk)
            if len(raw) > 8192:
                raise BridgeFailure()
        ack = unique_json(raw.decode("utf-8", errors="strict"))
        if type(ack) is not dict or ack.get("state") != "ENABLED" or not isinstance(ack.get("name"), str):
            raise BridgeFailure()
        if not re.fullmatch(r"projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/[1-9][0-9]{0,29}", ack["name"]):
            raise BridgeFailure()
        return {"name": ack["name"], "state": ack["state"]}
    except Exception:
        raise BridgeFailure() from None
    finally:
        for handle in (response, session):
            try:
                if handle is not None:
                    handle.close()
            except Exception:
                pass
def live_identity():
    import sys
    sys.path[:0] = [SDK_ROOT + "/lib", SDK_ROOT + "/lib/third_party"]
    from googlecloudsdk.core import properties
    from googlecloudsdk.core.credentials import creds
    from google.oauth2.credentials import Credentials
    account = properties.VALUES.core.account.Get()
    if not isinstance(account, str) or hashlib.sha256(account.encode()).hexdigest() != OPERATOR_HASH:
        raise BridgeFailure()
    # Read only this stored user's SDK identity. No ADC/static-provider/metadata
    # fallback, credential-file override, impersonation or new login is used.
    credential = creds.GetCredentialStore().Load(account)
    if not isinstance(credential, Credentials):
        raise BridgeFailure()
    return account, credential
def main():
    import os, sys, logging, http.client
    output = os.dup(1)
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    logging.disable(logging.CRITICAL)
    http.client.HTTPConnection.debuglevel = 0
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise BridgeFailure()
        credential = unique_json(raw.decode("utf-8", errors="strict"))
        # No production import happens when this module is loaded by the fake
        # transport harness with __name__ set to synthetic_test.
        import sys
        sys.path[:0] = [SDK_ROOT + "/lib", SDK_ROOT + "/lib/third_party"]
        from requests import Session
        from requests.adapters import HTTPAdapter
        from google.auth.transport.requests import Request
        ack = submit(credential, live_identity, Session, HTTPAdapter, Request)
        os.write(output, json.dumps(ack, separators=(",", ":")).encode())
    except BaseException:
        os.write(output, b'{"code":"BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN"}')
        return 1
    finally:
        os.close(output)
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
`;
function sdkRequest({operatorAccount,credential,operatorAccountSha256=BOOTSTRAP.operatorAccountSha256}){
  if(typeof operatorAccount!=='string'||! /^[a-f0-9]{64}$/.test(operatorAccountSha256)||sha(operatorAccount)!==operatorAccountSha256)fail('BOOTSTRAP_APPROVAL_REQUIRED');
  if(!sameKeys(credential,['client_id','access_token','refresh_token','token_type','scope','resource','expires_at'])
    ||!clientId(credential.client_id)||typeof credential.access_token!=='string'||!credential.access_token.trim()
    ||typeof credential.refresh_token!=='string'||!credential.refresh_token.trim()||credential.token_type!=='Bearer'
    ||credential.scope!=='mcp.read'||credential.resource!==BOOTSTRAP.resource||!Number.isSafeInteger(credential.expires_at)||credential.expires_at<=0)fail('BOOTSTRAP_TOKEN_INVALID');
  return {executable:BOOTSTRAP.python,args:['-I','-c',SDK_BRIDGE_CODE],operatorAccount,
    env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CLOUDSDK_CONFIG:'/Users/huanwu/.config/gcloud',
      CLOUDSDK_CORE_ACCOUNT:operatorAccount,CLOUDSDK_CORE_PROJECT:BOOTSTRAP.project,
      CLOUDSDK_CORE_LOG_HTTP:'false',CLOUDSDK_CORE_VERBOSITY:'none',CLOUDSDK_CORE_DISABLE_PROMPTS:'1',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:'',CLOUDSDK_CORE_UNIVERSE_DOMAIN:'googleapis.com'},
    stdin:Buffer.from(JSON.stringify(credential)),timeoutMs:BOOTSTRAP.writerMs,stdoutLimit:8192,discardStderr:true};
}
export function createSdkWriter({operatorAccount,runProcess,operatorAccountSha256=BOOTSTRAP.operatorAccountSha256}={}){
  // An injected fake process may use a synthetic identity hash. The real bridge
  // independently pins the original operator and cannot inherit that override.
  if(typeof operatorAccount!=='string'||! /^[a-f0-9]{64}$/.test(operatorAccountSha256)||sha(operatorAccount)!==operatorAccountSha256||typeof runProcess!=='function')fail('BOOTSTRAP_APPROVAL_REQUIRED');
  let submitted=false;
  return {async save(credential,{signal,precedingVersion,operatorAccount:requestedAccount}={}){
    if(submitted)fail('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN');
    if(requestedAccount!==operatorAccount||!version(precedingVersion))fail('BOOTSTRAP_APPROVAL_REQUIRED');
    const request=sdkRequest({operatorAccount,credential,operatorAccountSha256});if(signal?.aborted){request.stdin.fill(0);fail('BOOTSTRAP_CANCELLED');}submitted=true;
    try{
      const result=await runProcess({...request,signal});
      if(result?.exitCode!==0||typeof result.stdout!=='string')fail('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN');
      const raw=uniqueCloudJson(result.stdout,8192),ack=validateIbRotationReceipt(raw);
      if(BigInt(ack.name.split('/').at(-1))<=BigInt(precedingVersion))fail('BOOTSTRAP_SECRET_ACK_INVALID');
      return {name:ack.name,state:ack.state};
    }catch(error){if(error instanceof SafeError)throw error;fail('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN');}
    finally{request.stdin.fill(0);}
  }};
}
