// IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1. Import/CLI defaults are strictly offline.
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {uniqueCloudJson,validateIbRotationReceipt,validateBoundIbVersionName} from '../cloud/xuan-preopen/cloud_io.mjs';

export const BOOTSTRAP_SPEC='IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1';
export const BOOTSTRAP=Object.freeze({issuer:'https://api.ibkr.com',register:'https://api.ibkr.com/oauth2/register',
  authorize:'https://api.ibkr.com/oauth2/authorize',token:'https://api.ibkr.com/oauth2/api/v1/token',
  resource:'https://api.ibkr.com/v1/api/mcp-public',project:'family-portfolio-gateway',
  secret:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp',job:'xuan-preopen-orders-probe',
  sourceSa:'xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com',bucket:'family-portfolio-gateway-xuan-preopen-private',
  clientName:'XUAN Preopen Cloud Read-only v2',scope:'mcp.read',callbackPath:'/oauth/ib/callback',startPath:'/oauth/ib/start',
  ttlMs:600000,finalizeMs:40000,maintenanceMs:5000,httpMs:15000,writerMs:20000,maxResponseBytes:65536,
  sdkRoot:'/Users/huanwu/Documents/Codex/2026-07-13/chatgpt-conversation-6a36247f-db60-83e8-b9c6/.tools/google-cloud-sdk',
  python:'/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12',
  operatorAccountSha256:'1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee'});
const CODES=new Set(['OFFLINE_PREPARATION_ONLY','BOOTSTRAP_REQUEST_INVALID','BOOTSTRAP_APPROVAL_REQUIRED',
  'BOOTSTRAP_PROFILE_REVIEW_REQUIRED','BOOTSTRAP_LISTENER_BINDING_INVALID','BOOTSTRAP_CALLBACK_INVALID',
  'BOOTSTRAP_SESSION_EXPIRED','BOOTSTRAP_FINALIZATION_EXPIRED','BOOTSTRAP_CANCELLED','BOOTSTRAP_REPLAY_REJECTED','BOOTSTRAP_OWNER_AUTHORIZATION_REJECTED',
  'BOOTSTRAP_DCR_REJECTED','BOOTSTRAP_DCR_OUTCOME_UNKNOWN','BOOTSTRAP_EXCHANGE_REJECTED','BOOTSTRAP_EXCHANGE_OUTCOME_UNKNOWN',
  'BOOTSTRAP_TOKEN_INVALID','BOOTSTRAP_MAINTENANCE_UNCONFIRMED','BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN',
  'BOOTSTRAP_SECRET_ACK_INVALID','BOOTSTRAP_INTERNAL_FAILED','BOOTSTRAP_AWAITING_OWNER','BOOTSTRAP_SECRET_VERSION_CONFIRMED']);
class SafeError extends Error{constructor(code){super(CODES.has(code)?code:'BOOTSTRAP_INTERNAL_FAILED');}}
const fail=code=>{throw new SafeError(code);};
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
export function registrationProfile(redirectUri){
  validateLoopbackUri(redirectUri);
  return {client_name:BOOTSTRAP.clientName,scope:BOOTSTRAP.scope,grant_types:['authorization_code','refresh_token'],
    response_types:['code'],token_endpoint_auth_method:'none',redirect_uris:[redirectUri]};
}
function registrationReceipt(raw,{redirectUri,codeSha256,now}){
  const profile=registrationProfile(redirectUri);
  if(!object(raw)||!clientId(raw.client_id)||raw.client_name!==profile.client_name||raw.scope!==profile.scope
    ||raw.token_endpoint_auth_method!=='none'||!exactSet(raw.redirect_uris,[redirectUri])
    ||!exactSet(raw.grant_types,profile.grant_types)||!exactSet(raw.response_types,['code'])
    ||Object.hasOwn(raw,'client_secret')||Object.hasOwn(raw,'token_endpoint_auth_signing_alg'))fail('BOOTSTRAP_PROFILE_REVIEW_REQUIRED');
  return Object.freeze({spec:BOOTSTRAP_SPEC,clientId:raw.client_id,clientName:raw.client_name,redirectUri,
    tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],scope:'mcp.read',
    issuer:BOOTSTRAP.issuer,resource:BOOTSTRAP.resource,observedAtUtc:new Date(now()).toISOString(),
    issuerEvidence:'fixed-endpoint',resourceEvidence:'explicit-request-only',
    timestampEvidence:'local-registration-response-received',codeSha256,
    managementCredentialReturned:Object.hasOwn(raw,'registration_access_token'),managementCredentialPersisted:false});
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
    try{return await boundedJson(response,combined);}catch{fail(unknown);}
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

export function createBootstrap({approval,fetchImpl,listener,browser,store,maintenance,clock=defaultClock,randomBytes=crypto.randomBytes,
  operatorAccountSha256=BOOTSTRAP.operatorAccountSha256}={}){
  const approved=validateApproval(approval,operatorAccountSha256);
  if(typeof fetchImpl!=='function'||typeof listener?.bind!=='function'||typeof browser?.open!=='function'||typeof store?.save!=='function'
    ||typeof maintenance?.check!=='function')fail('BOOTSTRAP_APPROVAL_REQUIRED');
  let phase='prepared',bound=null,bindPending=null,closePending=null,started=false,used=false,startUsed=false,stopped=false,listenerClosed=true,timer,deadline=0,finalDeadline=0,receipt=null,scopeEvidence=null;
  let sensitive=null;const controller=new AbortController();
  const effects={registration:'not-started',codeExchange:'not-started',secretWrite:'not-started'};
  let terminal=null,savedVersion=null,resolveFinished,lastCode='BOOTSTRAP_AWAITING_OWNER',lastStatus='pending';const finished=new Promise(resolve=>{resolveFinished=resolve;});
  const snapshot=(code,status='pending')=>({status,code,phase,sideEffects:{...effects},registration:receipt,
    scopeEvidence,savedVersion,listenerClosed,automaticRetry:false,nativeAccountProof:false});
  const close=async()=>{stopped=true;clock.clearTimeout(timer);controller.abort();sensitive=null;
    // A cancelled bind may resolve late. Wait for ownership before closing it.
    if(bindPending){try{await bindPending;}catch{listenerClosed=true;}}
    if(bound&&!closePending){closePending=(async()=>{try{await bound.close();listenerClosed=true;}catch{listenerClosed=false;}})();}
    if(closePending)await closePending;
  };
  const finish=async(code,status='failed')=>{terminal??={code,status};lastCode=terminal.code;lastStatus=terminal.status;await close();
    const result=snapshot(terminal.code,terminal.status);resolveFinished(result);return result;};
  const alive=()=>{if(stopped||clock.now()>=(used?finalDeadline:deadline))fail(used?'BOOTSTRAP_FINALIZATION_EXPIRED':'BOOTSTRAP_SESSION_EXPIRED');};
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
      bindPending=Promise.resolve().then(()=>listener.bind({host:'127.0.0.1',port:Number(uri.port)})).then(resource=>{bound=resource;return resource;});
      await bindPending;
      alive();
      if(bound.host!=='127.0.0.1'||bound.port!==Number(uri.port)||`http://${bound.host}:${bound.port}${BOOTSTRAP.callbackPath}`!==approved.redirectUri)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
      alive();await verifyMaintenance(maintenance,approved.precedingVersion,{clock,signal:controller.signal});alive();
      phase='register';effects.registration='unknown';
      const raw=await oauthPost(BOOTSTRAP.register,JSON.stringify(registrationProfile(approved.redirectUri)),{fetchImpl,clock,signal:controller.signal,phase:'register'});
      effects.registration='confirmed';receipt=registrationReceipt(raw,{redirectUri:approved.redirectUri,codeSha256:approved.codeSha256,now:clock.now});alive();
      phase='await-owner';bound.setHandler(handleHttp);
      // Only the non-sensitive loopback start URL reaches a browser adapter.
      // That same browser receives an HttpOnly session cookie before redirect.
      await browser.open(new URL(BOOTSTRAP.startPath,approved.redirectUri).href);alive();
      return snapshot('BOOTSTRAP_AWAITING_OWNER');
    }catch(error){if(safeCode(error)==='BOOTSTRAP_DCR_REJECTED')effects.registration='rejected';return reject(error);}
  };
  return Object.freeze({start,handleHttp,finished,snapshot:()=>snapshot(lastCode,lastStatus),cancel:async()=>{phase='cancelled';return finish('BOOTSTRAP_CANCELLED');}});
}

// These factories are inert. Tests use fakes; no factory is invoked by CLI.
export function createNodeLoopbackAdapter(){
  return {async bind({host,port}){
    if(host!=='127.0.0.1'||!Number.isInteger(port)||port<0||port>65535)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
    const {createServer}=await import('node:http');let handler=null;
    const server=createServer(async(req,res)=>{
      let response;try{
        const hosts=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='host').length;
        response=handler?await handler({method:req.method,host:req.headers.host,hostCount:hosts,rawUrl:req.url,cookie:req.headers.cookie}):{statusCode:404,body:'Not active.'};
      }catch{response={statusCode:400,body:'Authorization stopped.'};}
      if(!res.destroyed){res.writeHead(response.statusCode,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
        'x-content-type-options':'nosniff','connection':'close',...(response.headers||{})});res.end(response.body);}
    });
    server.requestTimeout=5000;server.headersTimeout=5000;server.maxHeadersCount=32;
    try{await new Promise((resolve,reject)=>{server.once('error',()=>reject(new SafeError('BOOTSTRAP_LISTENER_BINDING_INVALID')));server.listen({host,port,exclusive:true},resolve);});}
    catch{server.close();fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}
    const address=server.address();if(!address||typeof address==='string'||address.address!=='127.0.0.1'){server.close();fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}
    return {host:address.address,port:address.port,setHandler(fn){handler=fn;},async close(){handler=null;server.close();server.closeIdleConnections();}};
  }};
}
export function createExternalBrowserAdapter(){
  return {async open(startUri){
    let u;try{u=new URL(startUri);}catch{fail('BOOTSTRAP_REQUEST_INVALID');}validateLoopbackUri(u.origin+BOOTSTRAP.callbackPath);
    if(u.pathname!==BOOTSTRAP.startPath||u.search||u.hash||u.username||u.password)fail('BOOTSTRAP_REQUEST_INVALID');
    // The argument has no state, code, cookie, verifier or authorization query.
    const {spawn}=await import('node:child_process');
    try{await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/open',[startUri],{shell:false,stdio:'ignore'});
      child.once('error',()=>reject(new SafeError('BOOTSTRAP_INTERNAL_FAILED')));child.once('exit',code=>code===0?resolve():reject(new SafeError('BOOTSTRAP_INTERNAL_FAILED')));});}
    catch{fail('BOOTSTRAP_INTERNAL_FAILED');}
  }};
}
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
export function createSdkProcessBridge(){
  return async request=>{
    const account=request?.operatorAccount;
    let clean;try{
      if(typeof account!=='string'||sha(account)!==BOOTSTRAP.operatorAccountSha256||!Buffer.isBuffer(request.stdin))fail('BOOTSTRAP_APPROVAL_REQUIRED');
      clean=sdkRequest({operatorAccount:account,credential:uniqueCloudJson(request.stdin.toString('utf8'),65536)});
      if(request.executable!==clean.executable||!Array.isArray(request.args)||request.args.join('\0')!==clean.args.join('\0')
        ||request.discardStderr!==true||request.timeoutMs!==BOOTSTRAP.writerMs||request.stdoutLimit!==8192)fail('BOOTSTRAP_APPROVAL_REQUIRED');
    }catch{clean?.stdin.fill(0);fail('BOOTSTRAP_APPROVAL_REQUIRED');}
    clean.stdin.fill(0);
    const {spawn}=await import('node:child_process');
    return new Promise((resolve,reject)=>{
      let settled=false,stdout='',size=0,timer,child;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);request.signal?.removeEventListener('abort',abort);if(error){child?.kill('SIGKILL');reject(new SafeError('BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN'));}else resolve(value);};
      const abort=()=>finish(true);if(request.signal?.aborted){finish(true);return;}
      // Ignore caller env completely: no SDK endpoint/debug/credential overrides.
      child=spawn(BOOTSTRAP.python,clean.args,{shell:false,env:clean.env,cwd:'/private/tmp',stdio:['pipe','pipe','pipe']});
      timer=setTimeout(abort,BOOTSTRAP.writerMs);request.signal?.addEventListener('abort',abort,{once:true});
      child.on('error',abort);child.stdin.on('error',abort);
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8192)abort();else stdout+=chunk.toString('utf8');});
      child.stderr.on('data',()=>{}); // Never return, log, or persist raw SDK stderr.
      child.on('close',code=>finish(false,{exitCode:code,stdout}));child.stdin.end(request.stdin);
    });
  };
}

export function offlineApprovalTemplate(){
  return {spec:BOOTSTRAP_SPEC,status:'OFFLINE_PREPARATION_ONLY',liveApproved:false,codeHead:null,imageDigest:null,
    redirectUri:null,operatorIdentity:null,precedingSecretVersion:null,registrationProfile:{client_name:BOOTSTRAP.clientName,
      scope:'mcp.read',grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',redirect_uris:'one-preflight-bound-uri-required'},
    budgets:{registration:1,ownerConsentAndCodeExchange:1,initialSecretVersions:1,sequentialOrdersCalls:2,normalExpiryRefresh:1,rotationSecretVersions:1},
    timing:{callbackAdmissionMs:BOOTSTRAP.ttlMs,acceptedCallbackFinalizationMs:BOOTSTRAP.finalizeMs,exchangeMs:BOOTSTRAP.httpMs,maintenanceCheckMs:BOOTSTRAP.maintenanceMs,writeMs:BOOTSTRAP.writerMs,automaticRetries:0},
    fixed:{issuer:BOOTSTRAP.issuer,resource:BOOTSTRAP.resource,project:BOOTSTRAP.project,secret:BOOTSTRAP.secret,job:BOOTSTRAP.job,sourceSa:BOOTSTRAP.sourceSa,bucket:BOOTSTRAP.bucket},
    required:['exact final code and optional existing-job image','real bound URI frozen after separate preflight','original operator identity',
      'all original-Secret consumers paused and drained; manual old-version runs blocked; preceding version checked',
      'explicit acceptance that new consent may replace Mac','no automatic retry after unknown outcome',
      'first version-bound orders call; second only in the real existing expiry window; next version from confirmed ack',
      'maintain pause after failed validation; privately verify consumers will use confirmed version; do not enable closed schedules'],
    observedJobSnapshot:{checkedAtUtc:'2026-10-16T01:01:30.430238Z',cpu:'1',memory:'512Mi',taskCount:1,maxRetries:0,timeoutSeconds:180,
      entrypointPurpose:'private-action-preview',compatibleWithOrdersOnlyAcceptance:false,currentConfigurationNotReadThisPreparation:true},
    requiredJobBeforeLive:{entrypoint:'node cloud/xuan-preopen/orders_probe.mjs',immutableReviewedImageDigest:null,taskCount:1,maxRetries:0,timeoutSeconds:75,changesApproved:false},
    cost:{newInfrastructureUsd:0,maxNewSecretVersions:2,fullMonthSecretUsdFormula:'0.12 * verified billable replica locations',
      replicaLocations:null,jobCpu:1,jobMemoryGiB:.5,cpuSecondsUpperBound:150,memoryGiBSecondsUpperBound:75,
      resourceEvidence:'historical verified job snapshot; recheck before approval',unitPricesVerified:false,imageBuildCostVerified:false,
      jobTasks:'at most two, 75 seconds each',incrementalApprovalThresholdUsd:1,
      thresholdIsHardBillingCap:false,belowThresholdVerified:false,historicalOrFutureUnlimitedRotationIncluded:false,automaticVersionDeletion:false}};
}
export async function bootstrapCli(args=[]){
  if(!(args.length===0||args.length===1&&args[0]==='--plan'))return {status:'failed',code:'BOOTSTRAP_REQUEST_INVALID',liveActions:0};
  return offlineApprovalTemplate();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))bootstrapCli(process.argv.slice(2)).then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='failed')process.exitCode=1;
}).catch(()=>{process.stdout.write('{"status":"failed","code":"BOOTSTRAP_INTERNAL_FAILED","liveActions":0}\n');process.exitCode=1;});
