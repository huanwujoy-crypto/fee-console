// Separate normal orders-only entry using the existing transport and validators.
// Importing this module never starts credentials, sources or the legacy probe.
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {captureCloudIbOrders,RESOURCE,TOKEN_ENDPOINT,validateCredential} from './ib_mcp.mjs';
import {privateCloudIo,boundedText,uniqueCloudJson,validateBoundIbVersionName,validateIbRotationReceipt} from './cloud_io.mjs';
import {ibError,safeIbFailure} from './ib_diagnostics.mjs';
import {validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import {unwrapSource} from '../../scripts/xuan-ib-source-adapter.mjs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
// Pure existing validators only; never invoke the probe CLI or probe runner.
import {inspectOrdersAccountEvidence,loadProbeAssociation,validateOrdersProbeRequest} from './orders_probe.mjs';
const failure=(code,phase='diagnostic_request',category='forbidden')=>ibError(code,{phase,category});
export async function runCloudOrdersRead({request,env=process.env,now=Date.now,fetchImpl=fetch,io,loadContext=loadProbeAssociation,capture=captureCloudIbOrders,expectedAccount=APPROVED_IB_ACCOUNT_ID,limits={}}={}){
  let claimed=false,upstreamAttempted=false,ordersCalls=0,refreshCalls=0,saveCalls=0,start,association=null,originalClient=null,originalRefresh=null,accountEvidence=null,transportAccountMatched=false,credentialPersistence='not-needed';
  try{validateOrdersProbeRequest(request,{now:now(),env});
    if(!Object.hasOwn(request,'credentialBinding'))throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_load','scope_invalid');
  }catch(e){return {...safeIbFailure(e),upstreamAttempted:false};}
  const binding=request.credentialBinding;
  let consumedCredentialVersion=null,savedCredentialVersion=null,credentialClientMatched=false,credentialVersionMatched=false;
  const bindingReceipt=()=>binding?{consumedCredentialVersion,savedCredentialVersion,credentialClientMatched,credentialVersionMatched}:{};
  // Limits can only shorten offline test windows. There is no CLI/env override.
  const sourceMs=Math.min(45000,Number.isFinite(limits.sourceMs)&&limits.sourceMs>0?limits.sourceMs:45000,Date.parse(request.expiresAt)-now());
  const finalizeMs=Math.min(20000,Number.isFinite(limits.finalizeMs)&&limits.finalizeMs>0?limits.finalizeMs:20000);
  const startedAt=new Date(now()).toISOString(),prefix='report-check/orders-read-'+request.requestId+'/',sourceController=new AbortController(),finalController=new AbortController();
  const sourceDeadline=performance.now()+sourceMs,hardDeadline=sourceDeadline+finalizeMs;
  let finalizing=false,finalTimer=setTimeout(()=>finalController.abort(new DOMException('Bounded finalization ended','TimeoutError')),sourceMs+finalizeMs),sourceTimer;
  const finalize=()=>{
    if(finalizing)return;finalizing=true;clearTimeout(sourceTimer);sourceController.abort(new DOMException('Source cutoff','TimeoutError'));
    clearTimeout(finalTimer);finalTimer=setTimeout(()=>finalController.abort(new DOMException('Bounded finalization ended','TimeoutError')),Math.max(0,Math.min(hardDeadline-performance.now(),finalizeMs)));
  };
  sourceTimer=setTimeout(finalize,sourceMs);
  const guardSource=()=>{if(finalizing||performance.now()>=sourceDeadline||now()>=Date.parse(request.expiresAt)){finalize();sourceController.signal.throwIfAborted();}sourceController.signal.throwIfAborted();};
  const phaseFetch=signal=>async(url,options={})=>{signal.throwIfAborted();return fetchImpl(url,{...options,signal:options.signal?AbortSignal.any([options.signal,signal]):signal});};
  const finalFetch=phaseFetch(finalController.signal);
  const sourceFetch=async(url,options={})=>{
    guardSource();const u=String(url);
    if(binding&&(!credentialVersionMatched||!credentialClientMatched||originalClient!==binding.clientId))throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_load','scope_invalid');
    if(u!==TOKEN_ENDPOINT&&u!==RESOURCE)throw failure('IB_MCP_METHOD_FORBIDDEN','mcp_orders_read');
    if(u===TOKEN_ENDPOINT&&(options.method!=='POST'||!(options.body instanceof URLSearchParams)
      ||[...options.body.keys()].sort().join('|')!=='client_id|grant_type|refresh_token|resource|scope'
      ||options.body.get('grant_type')!=='refresh_token'||options.body.get('scope')!=='mcp.read'
      ||options.body.get('resource')!==RESOURCE||originalClient===null||options.body.get('client_id')!==originalClient
      ||originalRefresh===null||options.body.get('refresh_token')!==originalRefresh
      ||new Headers(options.headers).has('authorization')||new Headers(options.headers).has('cookie')))throw failure('IB_MCP_TOOL_FORBIDDEN','oauth_refresh');
    if(u===TOKEN_ENDPOINT&&++refreshCalls>1)throw failure('IB_DIAGNOSTIC_LIMIT_EXCEEDED','oauth_refresh','counter_limit');
    if(u===RESOURCE){if(options.method!=='POST'||!options.body)throw failure('IB_MCP_METHOD_FORBIDDEN','mcp_orders_read');const body=uniqueCloudJson(options.body,100000);if(body.method==='tools/call'){
      if(body.params?.name!=='get_account_orders'||Object.keys(body.params).sort().join('|')!=='arguments|name'
        ||!body.params.arguments||Object.getPrototypeOf(body.params.arguments)!==Object.prototype||Object.keys(body.params.arguments).length!==0||ordersCalls>=1)throw failure('IB_MCP_TOOL_FORBIDDEN','mcp_orders_read');ordersCalls++;
    }else if(!['initialize','notifications/initialized'].includes(body.method))throw failure('IB_MCP_METHOD_FORBIDDEN','mcp_orders_read');}
    upstreamAttempted=true;
    if(u===TOKEN_ENDPOINT){
      credentialPersistence='exchange-started';
      try{const response=await finalFetch(url,options);credentialPersistence=response.ok?'response-received':'exchange-rejected';
        if(binding){
          let text,token;try{text=await boundedText(response,16384);token=uniqueCloudJson(text,16384);}
          catch{throw failure('IB_REFRESH_RESPONSE_INVALID','oauth_refresh','response_invalid');}
          if(response.ok&&(Object.hasOwn(token??{},'refresh_token')&&(typeof token.refresh_token!=='string'||!token.refresh_token.trim())
            ||Object.hasOwn(token??{},'client_id')&&token.client_id!==binding.clientId
            ||Object.hasOwn(token??{},'resource')&&token.resource!==RESOURCE))throw failure('IB_REFRESH_SCOPE_INVALID','oauth_refresh','scope_invalid');
          return new Response(text,{status:response.status,headers:{'content-type':'application/json'}});
        }
        return response;}
      catch(error){credentialPersistence='exchange-outcome-unknown';throw error;}
    }
    return phaseFetch(sourceController.signal)(url,options);
  };
  // Private transport is deliberately not tied to the source cutoff. Even a
  // rotated credential and a failure receipt must use the bounded final window.
  io??=privateCloudIo({fetchImpl:finalFetch,now});
  try{
    guardSource();const context=await loadContext({now,fetchImpl:phaseFetch(sourceController.signal)});validateAssociationSnapshot(context.association,{now:now(),edition:'adhoc'});
    association={policyCommit:context.association.policyCommit,policyBlob:context.association.policyBlob,checkedAt:context.association.checkedAt,accountAlias:context.association.policy.accountAlias};
    start={schemaVersion:1,mode:'cloud-orders-read',requestId:request.requestId,dataDate:request.dataDate,execution:env.CLOUD_RUN_EXECUTION,startedAt,expiresAt:request.expiresAt};
    guardSource();try{await io.savePrivate(prefix+'start.json',start);claimed=true;}
    catch(error){throw failure(error?.message==='CLOUD_HTTP_412'?'IB_DIAGNOSTIC_ATTEMPT_CONSUMED':'IB_DIAGNOSTIC_ATTEMPT_OUTCOME_UNKNOWN','attempt_claim',error?.message==='CLOUD_HTTP_412'?'attempt_consumed':'attempt_outcome_unknown');}
    const store={load:async()=>{
      guardSource();let credential;
      if(binding){
        if(typeof io.ibStore.loadBound!=='function')throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_load','scope_invalid');
        const bound=await io.ibStore.loadBound(binding);guardSource();
        validateBoundIbVersionName(bound?.versionName,binding.version);credentialVersionMatched=true;
        if(bound?.credential?.client_id!==binding.clientId)throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_load','scope_invalid');
        credentialClientMatched=true;consumedCredentialVersion=bound.versionName;credential=bound.credential;
      }else{credential=await io.ibStore.load();guardSource();}
      if(binding)validateCredential(credential);originalClient=credential?.client_id??null;originalRefresh=credential?.refresh_token??null;return credential;
    }};
    if(typeof io.ibStore.save==='function')store.save=async credential=>{
      if(credential?.client_id!==originalClient||refreshCalls!==1||saveCalls!==0)throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_save','scope_invalid');
      validateCredential(credential);saveCalls++;credentialPersistence='saving';
      try{finalController.signal.throwIfAborted();const saved=await io.ibStore.save(credential);
        if(binding){const ack=validateIbRotationReceipt(saved),version=ack.name.split('/').at(-1);
          if(BigInt(version)<=BigInt(binding.version))throw failure('IB_TOKEN_ROTATION_OUTCOME_UNKNOWN','credential_save','save_outcome_unknown');
          savedCredentialVersion=ack.name;
        }
        credentialPersistence='saved';return saved;}
      catch(error){credentialPersistence=/^CLOUD_HTTP_4\d\d$/.test(error?.message||'')?'rejected':'outcome-unknown';throw error;}
    };
    store.requiresCredentialLease=io.ibStore.requiresCredentialLease===true;
    if(typeof io.ibStore.withCredentialLease==='function')store.withCredentialLease=callback=>io.ibStore.withCredentialLease(callback);
    const captured=await capture(store,{now,fetchImpl:sourceFetch,signal:sourceController.signal,refreshSignal:finalController.signal,
      inspectEnvelope:value=>{const evidence=inspectOrdersAccountEvidence(value,{expectedAccount});if(evidence.responseAccountEvidence==='matched')transportAccountMatched=true;},allowRefresh:true});
    guardSource();
    if(captured?.status!=='captured'||captured.sources?.length!==1||captured.sources[0].sourceKey!=='ib.orders'||ordersCalls!==1||!upstreamAttempted)throw failure('IB_DIAGNOSTIC_ORDERS_INVALID','orders_validate','contract_invalid');
    unwrapSource('orders',captured.sources[0].raw);accountEvidence=inspectOrdersAccountEvidence(captured.sources[0].raw,{expectedAccount});
    if(transportAccountMatched)accountEvidence={associationBasis:'owner-attested',responseAccountEvidence:'matched',nativeIdentityEvidence:'response-account-id'};
    // Retain the closed transport verdict in the hashed private source object,
    // since decoded orders intentionally omit outer RPC metadata/text wrappers.
    captured.sources[0].accountEvidence=accountEvidence;
    finalize();
    const current=await loadContext({now,fetchImpl:finalFetch});validateAssociationSnapshot(current.association,{now:now(),edition:'adhoc'});
    if(current.association.policyBlob!==context.association.policyBlob)throw failure('IB_DIAGNOSTIC_ASSOCIATION_CHANGED','association_validate','policy_invalid');
    finalController.signal.throwIfAborted();
    const artifact={privateObject:prefix+'orders.json',...await io.savePrivate(prefix+'orders.json',captured.sources[0])};
    const receipt={...start,status:'passed',completedAt:new Date(now()).toISOString(),association,...accountEvidence,credentialPersistence,upstreamAttempted,ordersCalls,refreshCalls,artifact,...bindingReceipt()};
    const saved=await io.savePrivate(prefix+'receipt.json',receipt);
    return {status:'passed',code:'IB_CLOUD_ORDERS_READ_SUCCEEDED',requestId:request.requestId,startedAt,completedAt:receipt.completedAt,execution:env.CLOUD_RUN_EXECUTION,upstreamAttempted,...accountEvidence,credentialPersistence,receiptSha256:saved.sha256,...bindingReceipt()};
  }catch(error){
    finalize();
    if(['AbortError','TimeoutError'].includes(error?.name))error=failure('IB_DIAGNOSTIC_TIMEOUT','diagnostic_request','timeout');
    const safe=safeIbFailure(error,{fallback:claimed?'IB_DIAGNOSTIC_FAILED':'IB_DIAGNOSTIC_ATTEMPT_FAILED'});
    const summary={...safe,requestId:request.requestId,startedAt,completedAt:new Date(now()).toISOString(),execution:env.CLOUD_RUN_EXECUTION,upstreamAttempted,credentialPersistence,...bindingReceipt()};
    if(claimed){try{await io.savePrivate(prefix+'receipt.json',{...start,...summary,association,accountEvidence,ordersCalls,refreshCalls});}catch{return {...summary,receiptSaved:false};}}
    return {...summary,receiptSaved:claimed};
  }finally{clearTimeout(sourceTimer);clearTimeout(finalTimer);sourceController.abort();finalController.abort();}
}
export async function ordersReadCli(args,options={}){
  if(args.length!==2||args[0]!=='--orders-request')return {...safeIbFailure(failure('IB_DIAGNOSTIC_REQUEST_INVALID')),upstreamAttempted:false};
  let request;try{request=uniqueCloudJson(args[1],65536);}catch{return {...safeIbFailure(failure('IB_DIAGNOSTIC_REQUEST_INVALID')),upstreamAttempted:false};}
  return runCloudOrdersRead({...options,request});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))ordersReadCli(process.argv.slice(2)).then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='passed')process.exitCode=1;
}).catch(()=>{process.stdout.write(JSON.stringify({status:'failed',code:'IB_DIAGNOSTIC_FAILED',upstreamAttempted:false})+'\n');process.exitCode=1;});
