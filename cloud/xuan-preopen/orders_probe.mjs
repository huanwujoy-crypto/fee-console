// Standalone current cloud orders test. No daily markers, catalog or new grant.
import crypto from 'node:crypto';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {captureCloudIbOrders,RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {privateCloudIo,boundedText} from './cloud_io.mjs';
import {ibError,safeIbFailure} from './ib_diagnostics.mjs';
import {validateAssociationSnapshot,ASSOCIATION_POLICY_PATH} from '../../scripts/xuan-ib-account-association.mjs';
import {unwrapSource} from '../../scripts/xuan-ib-source-adapter.mjs';
export const ORDERS_PROBE_JOB='xuan-preopen-orders-probe';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const day=t=>new Date(t+28800000).toISOString().slice(0,10);
const failure=(code,phase='diagnostic_request',category='forbidden')=>ibError(code,{phase,category});
export async function loadProbeAssociation({now=Date.now,fetchImpl=fetch}={}){
  const read=async url=>{const response=await fetchImpl(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'User-Agent':'xuan-cloud-orders-probe'}});if(!response.ok)throw failure('IB_DIAGNOSTIC_ASSOCIATION_INVALID','association_validate','policy_invalid');return boundedText(response,100000);};
  const sha=JSON.parse(await read('https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main'))?.object?.sha;
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw failure('IB_DIAGNOSTIC_ASSOCIATION_INVALID','association_validate','policy_invalid');
  const text=await read('https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/'+sha+'/'+ASSOCIATION_POLICY_PATH),bytes=Buffer.from(text);
  const association={policy:JSON.parse(text),policyCommit:sha,policyBlob:crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),checkedAt:new Date(now()).toISOString()};
  validateAssociationSnapshot(association,{now:now(),edition:'adhoc'});return {association};
}
export function validateOrdersProbeRequest(request,{now=Date.now(),env=process.env}={}){
  if(!request||Object.keys(request).sort().join('|')!=='dataDate|expiresAt|requestId'
    ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.requestId||'')
    ||request.dataDate!==day(now)||typeof request.expiresAt!=='string'||!Number.isFinite(Date.parse(request.expiresAt))
    ||new Date(request.expiresAt).toISOString()!==request.expiresAt||Date.parse(request.expiresAt)<=now||Date.parse(request.expiresAt)-now>15*60000
    ||day(Date.parse(request.expiresAt))!==request.dataDate)throw failure('IB_DIAGNOSTIC_REQUEST_INVALID');
  if(env.CLOUD_RUN_JOB!==ORDERS_PROBE_JOB||!/^xuan-preopen-orders-probe-[a-z0-9-]+$/.test(env.CLOUD_RUN_EXECUTION||'')
    ||env.CLOUD_RUN_TASK_INDEX!=='0'||env.CLOUD_RUN_TASK_ATTEMPT!=='0'||env.CLOUD_RUN_TASK_COUNT!=='1')throw failure('IB_DIAGNOSTIC_RUNTIME_REQUIRED');
  return request;
}
export async function runCloudOrdersProbe({request,env=process.env,now=Date.now,fetchImpl=fetch,io,loadContext=loadProbeAssociation,capture=captureCloudIbOrders}={}){
  let claimed=false,upstreamAttempted=false,ordersCalls=0,refreshCalls=0,start,association=null,originalClient=null;
  try{validateOrdersProbeRequest(request,{now:now(),env});}catch(e){return {...safeIbFailure(e),upstreamAttempted:false};}
  const startedAt=new Date(now()).toISOString(),prefix='report-check/orders-probe-'+request.requestId+'/',controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.min(45000,Date.parse(request.expiresAt)-now()));
  const boundedFetch=async(url,options={})=>{
    controller.signal.throwIfAborted();const u=String(url);
    if(u===TOKEN_ENDPOINT&&(options.method!=='POST'||options.body?.get('grant_type')!=='refresh_token'||options.body?.get('scope')!=='mcp.read'
      ||options.body?.get('resource')!==RESOURCE||originalClient===null||options.body?.get('client_id')!==originalClient))throw failure('IB_MCP_TOOL_FORBIDDEN','oauth_refresh');
    if(u===TOKEN_ENDPOINT&&++refreshCalls>1)throw failure('IB_DIAGNOSTIC_LIMIT_EXCEEDED','oauth_refresh','counter_limit');
    if(u===RESOURCE&&options.body){const body=JSON.parse(options.body);if(body.method==='tools/call'){
      if(body.params?.name!=='get_account_orders'||!body.params.arguments||Object.keys(body.params.arguments).length!==0||ordersCalls>=1)throw failure('IB_MCP_TOOL_FORBIDDEN','mcp_orders_read');ordersCalls++;
    }else if(!['initialize','notifications/initialized'].includes(body.method))throw failure('IB_MCP_METHOD_FORBIDDEN','mcp_orders_read');}
    if(u===RESOURCE||u===TOKEN_ENDPOINT)upstreamAttempted=true;
    return fetchImpl(url,{...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});
  };
  io??=privateCloudIo({fetchImpl:boundedFetch});
  try{
    const context=await loadContext({now,fetchImpl:boundedFetch});validateAssociationSnapshot(context.association,{now:now(),edition:'adhoc'});
    association={policyCommit:context.association.policyCommit,policyBlob:context.association.policyBlob,checkedAt:context.association.checkedAt,accountAlias:context.association.policy.accountAlias};
    start={schemaVersion:1,mode:'cloud-orders-probe',requestId:request.requestId,dataDate:request.dataDate,execution:env.CLOUD_RUN_EXECUTION,startedAt,expiresAt:request.expiresAt};
    try{await io.savePrivate(prefix+'start.json',start);claimed=true;}
    catch(error){throw failure(error?.message==='CLOUD_HTTP_412'?'IB_DIAGNOSTIC_ATTEMPT_CONSUMED':'IB_DIAGNOSTIC_ATTEMPT_OUTCOME_UNKNOWN','attempt_claim',error?.message==='CLOUD_HTTP_412'?'attempt_consumed':'attempt_outcome_unknown');}
    const store={load:async()=>{const credential=await io.ibStore.load();originalClient=credential?.client_id??null;return credential;}};
    if(typeof io.ibStore.save==='function')store.save=async credential=>{if(credential?.client_id!==originalClient)throw failure('IB_READ_ONLY_CREDENTIAL_REQUIRED','credential_save','scope_invalid');return io.ibStore.save(credential);};
    const captured=await capture(store,{now,fetchImpl:boundedFetch,signal:controller.signal,allowRefresh:true});
    if(captured?.status!=='captured'||captured.sources?.length!==1||captured.sources[0].sourceKey!=='ib.orders'||ordersCalls!==1||!upstreamAttempted)throw failure('IB_DIAGNOSTIC_ORDERS_INVALID','orders_validate','contract_invalid');
    unwrapSource('orders',captured.sources[0].raw);
    const current=await loadContext({now,fetchImpl:boundedFetch});validateAssociationSnapshot(current.association,{now:now(),edition:'adhoc'});
    if(current.association.policyBlob!==context.association.policyBlob)throw failure('IB_DIAGNOSTIC_ASSOCIATION_CHANGED','association_validate','policy_invalid');
    controller.signal.throwIfAborted();
    const artifact={privateObject:prefix+'orders.json',...await io.savePrivate(prefix+'orders.json',captured.sources[0])};
    const receipt={...start,status:'passed',completedAt:new Date(now()).toISOString(),association,upstreamAttempted,ordersCalls,refreshCalls,artifact};
    const saved=await io.savePrivate(prefix+'receipt.json',receipt);
    return {status:'passed',code:'IB_CLOUD_ORDERS_READ_SUCCEEDED',requestId:request.requestId,startedAt,completedAt:receipt.completedAt,execution:env.CLOUD_RUN_EXECUTION,upstreamAttempted,receiptSha256:saved.sha256};
  }catch(error){
    const safe=safeIbFailure(error,{fallback:claimed?'IB_DIAGNOSTIC_FAILED':'IB_DIAGNOSTIC_ATTEMPT_FAILED'});
    const summary={...safe,requestId:request.requestId,startedAt,completedAt:new Date(now()).toISOString(),execution:env.CLOUD_RUN_EXECUTION,upstreamAttempted};
    if(claimed){try{await io.savePrivate(prefix+'receipt.json',{...start,...summary,association,ordersCalls,refreshCalls});}catch{return {...summary,receiptSaved:false};}}
    return {...summary,receiptSaved:claimed};
  }finally{clearTimeout(timer);controller.abort();}
}
export async function ordersProbeCli(args,options={}){
  if(args.length!==2||args[0]!=='--request')return {...safeIbFailure(failure('IB_DIAGNOSTIC_REQUEST_INVALID')),upstreamAttempted:false};
  let request;try{request=JSON.parse(args[1]);}catch{return {...safeIbFailure(failure('IB_DIAGNOSTIC_REQUEST_INVALID')),upstreamAttempted:false};}
  return runCloudOrdersProbe({...options,request});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))ordersProbeCli(process.argv.slice(2)).then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='passed')process.exitCode=1;
}).catch(()=>{process.stdout.write(JSON.stringify({status:'failed',code:'IB_DIAGNOSTIC_FAILED',upstreamAttempted:false})+'\n');process.exitCode=1;});
