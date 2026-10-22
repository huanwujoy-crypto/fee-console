// One controlled cloud invocation. No deployment, public upload, viewer key or
// arbitrary financial reader. R3 owns all IB credential/abort/persistence IO.
import crypto from 'node:crypto';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {runCloudOrdersProbe,validateOrdersProbeRequest} from './orders_probe.mjs';
import {privateCloudIo,isIbCredentialLockRequest,BUCKET,PROJECT} from './cloud_io.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {safeIbFailure} from './ib_diagnostics.mjs';
import {composePrivateActionPreview} from './action_preview.mjs';
import {runPrivateEodReport,validateCompletedEodSession,saveCompletedDailyReport} from './eod_report.mjs';
import {loadTrustedContext,readSharesightAction} from './report.mjs';
import {createEodSnapshotReader} from './eod_adapters.mjs';
import {planPreopen} from './calendar.mjs';

const GATEWAY='https://family-portfolio-gateway-6ikas4b3ma-df.a.run.app';
const API='https://api.github.com/repos/huanwujoy-crypto/fee-console';
const RAW='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/';
const METADATA='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const IB_SECRET='https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/xuan-preopen-ib-mcp';
const GATEWAY_SECRET='https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/family-portfolio-gateway-key/versions/latest:access';
const UPLOAD='https://storage.googleapis.com/upload/storage/v1/b/'+BUCKET+'/o';
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const fixedError=code=>Object.assign(new Error(code),{previewCode:code});
const cap=(v,max)=>Number.isFinite(v)&&v>0?Math.min(v,max):max;
const controlledCodes=new Set(['PRIVATE_PREVIEW_REQUEST_INVALID','PRIVATE_PREVIEW_CALENDAR_INVALID','PRIVATE_PREVIEW_NETWORK_FORBIDDEN',
  'PRIVATE_PREVIEW_UPLOAD_LIMIT','PRIVATE_PREVIEW_EVIDENCE_UNCONFIRMED','PRIVATE_PREVIEW_ASSOCIATION_CHANGED','PRIVATE_PREVIEW_TIMEOUT','PRIVATE_PREVIEW_COMPOSITION_FAILED']);
function publicContextUrl(u){return [API+'/git/ref/heads/main',API+'/commits/main'].includes(u)
  ||new RegExp('^'+RAW.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[a-f0-9]{40}/(?:claude/xuan-ib-account-association-v1\\.json|claude/xuan-ib-etf-pending-calls-v1\\.json|xuan-ib/latest\\.meta\\.json|xuan-ib/latest\\.html)$').test(u);}
function safeIbSourceFailure(r,receipt){
  if(r?.status!=='failed'||r.upstreamAttempted!==true||r.receiptSaved!==true||receipt?.status!=='failed'
    ||receipt.code!==r.code||receipt.requestId!==r.requestId||receipt.execution!==r.execution
    ||!['not-needed','saved','exchange-rejected'].includes(r.credentialPersistence))return false;
  if(r.code==='IB_REFRESH_HTTP_FAILED')return r.credentialPersistence==='exchange-rejected'&&[400,401,403,429].includes(r.httpStatus);
  return ['IB_MCP_NETWORK_FAILED','IB_MCP_HTTP_FAILED','IB_MCP_AUTHENTICATION_REJECTED','IB_MCP_PERMISSION_DENIED','IB_DIAGNOSTIC_TIMEOUT'].includes(r.code)
    &&['not-needed','saved'].includes(r.credentialPersistence);
}
const ibSummary=r=>Object.fromEntries(['status','code','phase','category','httpStatus','upstreamAttempted','credentialPersistence'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));

export async function runPrivateActionPreviewOnce({request,env=process.env,now=Date.now,fetchImpl=fetch,limits={},dailyDelivery=false}={}){
  const startedAt=new Date(now()).toISOString(),monoStart=performance.now();let phase='preflight',probe=null,source=null,probeReceipt=null,observerFailed=false;
  let uploads=0,uploadBytes=0,sharesightGets=0;const seenScopes=new Set();
  let totalTimer,compositionTimer,compositionController;const totalController=new AbortController();
  const totalMs=170000,compositionMs=cap(limits.compositionMs,100000);
  try{
    validateOrdersProbeRequest(request,{now:now(),env});
    // Dispatch window is [expiresAt-55s, expiresAt+20s]. A late container
    // expires before financial IO; a 180s task never extends IB's 75s window.
    if(Date.parse(request.expiresAt)-now()>55000)throw fixedError('PRIVATE_PREVIEW_REQUEST_INVALID');
    if(typeof dailyDelivery!=='boolean')throw fixedError('PRIVATE_PREVIEW_REQUEST_INVALID');
    const plan=planPreopen(now()),dailyPrefix=`delivery/${plan.dataDate}/`;
    let sourceDate;try{sourceDate=plan.sourceDate;validateCompletedEodSession(sourceDate,now());}
    catch{throw fixedError('PRIVATE_PREVIEW_CALENDAR_INVALID');}
    const prefix='report-check/orders-probe-'+request.requestId+'/';
    const budgetUpload=(url,options)=>{
      if(options.method!=='POST'||url.origin+url.pathname!==UPLOAD||url.searchParams.get('uploadType')!=='media'||url.searchParams.get('ifGenerationMatch')!=='0'||!Buffer.isBuffer(options.body))throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
      if(++uploads>(dailyDelivery?13:10)||options.body.length>9000000||(uploadBytes+=options.body.length)>33554432)throw fixedError('PRIVATE_PREVIEW_UPLOAD_LIMIT');
      return url.searchParams.get('name');
    };
    const probeFetch=async(url,options={})=>{
      const u=String(url),parsed=new URL(u),method=options.method??'GET';
      if(phase==='ib-probe'&&isIbCredentialLockRequest(url,options))return fetchImpl(url,options);
      if(u===UPLOAD||parsed.origin+parsed.pathname===UPLOAD){
        const name=budgetUpload(parsed,options);
        if(!['start.json','orders.json','receipt.json'].some(file=>name===prefix+file)
          &&!(dailyDelivery&&phase==='daily-claim'&&name===dailyPrefix+'start.json'))throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
        // Provisional request copies only. Never inspect OAuth/Secret bodies,
        // consume/clone responses, inject IO, or weaken R3's AbortSignals.
        if(name===prefix+'orders.json'||name===prefix+'receipt.json'){
          try{const value=JSON.parse(options.body.toString('utf8'));if(name.endsWith('/orders.json'))source=value;else probeReceipt=value;}
          catch{observerFailed=true;}
        }
      }else if(!((method==='GET'&&(u===METADATA||u===IB_SECRET+'/versions/latest:access'||publicContextUrl(u)))
        ||method==='POST'&&[RESOURCE,TOKEN_ENDPOINT,IB_SECRET+':addVersion'].includes(u)))throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
      return fetchImpl(url,options);
    };
    if(dailyDelivery){
      phase='daily-claim';
      await privateCloudIo({fetchImpl:probeFetch}).savePrivate(dailyPrefix+'start.json',
        {dataDate:plan.dataDate,execution:env.CLOUD_RUN_EXECUTION,startedAt});
    }
    phase='ib-probe';
    probe=await runCloudOrdersProbe({request,env,now,fetchImpl:probeFetch,limits:{sourceMs:limits.sourceMs,finalizeMs:limits.finalizeMs}});
    const failedSource=safeIbSourceFailure(probe,probeReceipt);
    if(probe.status!=='passed'&&!failedSource)return {...probe,mode:'private-action-preview-once',previewGenerated:false};
    if(observerFailed||!probeReceipt||probeReceipt.requestId!==request.requestId||probeReceipt.execution!==env.CLOUD_RUN_EXECUTION
      ||probe.status==='passed'&&(!source||digest(probeReceipt)!==probe.receiptSha256||digest(source)!==probeReceipt.artifact?.sha256))throw fixedError('PRIVATE_PREVIEW_EVIDENCE_UNCONFIRMED');
    // R3 alone owns credential finalization. Never put an earlier caller abort
    // around its admitted refresh/save. Its <=65s bound leaves the remainder of
    // the fixed 170s process budget for composition only.
    const remaining=totalMs-(performance.now()-monoStart);
    if(remaining<=0)throw fixedError('PRIVATE_PREVIEW_TIMEOUT');
    totalTimer=setTimeout(()=>totalController.abort(new DOMException('Overall preview deadline','TimeoutError')),remaining);
    phase='composition';compositionController=new AbortController();
    compositionTimer=setTimeout(()=>compositionController.abort(new DOMException('Composition deadline','TimeoutError')),Math.max(1,Math.min(compositionMs,totalMs-(performance.now()-monoStart))));
    const signal=AbortSignal.any([totalController.signal,compositionController.signal]);
    const compositionDeadline=Math.min(monoStart+totalMs,performance.now()+compositionMs);
    const guardComposition=()=>{if(performance.now()>=compositionDeadline)compositionController.abort(new DOMException('Composition deadline','TimeoutError'));signal.throwIfAborted();};
    const captureStart=probe.status==='passed'?source.startedAt:probe.startedAt;
    let compositionPrefix=null,mirrorAllowed=false,dailyCompletionAllowed=false;
    const compositionFetch=async(url,options={})=>{
      guardComposition();const u=String(url),p=new URL(u),method=options.method??'GET';
      if(p.origin+p.pathname===UPLOAD){
        const name=budgetUpload(p,options);
        if(!(mirrorAllowed&&name===prefix+'preview-receipt.json')
          &&!(dailyCompletionAllowed&&['report.html','receipt.json'].some(file=>name===dailyPrefix+file))){
          const match=(name??'').match(/^report-check\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([a-f0-9-]{36})\/(ib\.flexEod\.json|sharesight\.ibGroupedPerformance\.json|sharesight\.noahPerformance\.json|ib\.optionalLive\.json|report\.html|receipt\.json)$/);
          if(!match||match[1]!==captureStart)throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
          const directory=name.slice(0,name.lastIndexOf('/')+1);compositionPrefix??=directory;
          if(directory!==compositionPrefix)throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
        }
      }else if(p.origin===GATEWAY&&p.pathname==='/v1/performance'&&method==='GET'){
        const portfolio=p.searchParams.get('portfolio'),group=portfolio==='IB-HK'?'83569':portfolio==='NOAH-HK'?'investment_type':null;
        if(!group||p.searchParams.size!==5||p.searchParams.get('grouping')!==group||p.searchParams.get('start_date')!==sourceDate||p.searchParams.get('end_date')!==sourceDate||p.searchParams.get('include_sales')!=='false'||seenScopes.has(portfolio)||++sharesightGets>2)throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
        seenScopes.add(portfolio);
      }else if(!(method==='GET'&&(u===METADATA||u===GATEWAY_SECRET||publicContextUrl(u))))throw fixedError('PRIVATE_PREVIEW_NETWORK_FORBIDDEN');
      return fetchImpl(url,{...options,signal:options.signal?AbortSignal.any([options.signal,signal]):signal});
    };
    let html;
    const cloud=privateCloudIo({fetchImpl:compositionFetch}),io={savePrivate:async(name,value)=>{
      const saved=await cloud.savePrivate(name,value);
      if(name.endsWith('/report.html'))html=value;
      return saved;
    },loadGatewayToken:cloud.loadGatewayToken};
    const loadContext=async options=>{const c=await loadTrustedContext({...options,fetchImpl:compositionFetch});
      if(c.association?.policyBlob!==probeReceipt.association?.policyBlob)throw fixedError('PRIVATE_PREVIEW_ASSOCIATION_CHANGED');return c;};
    const readSharesight=(date,token,options)=>readSharesightAction(date,token,{...options,fetchImpl:compositionFetch});
    let receipt;
    if(probe.status==='passed'){
      const bundle={receipt:probeReceipt,source,receiptSha256:probe.receiptSha256,object:{name:probeReceipt.artifact.privateObject,generation:probeReceipt.artifact.generation,sha256:probeReceipt.artifact.sha256}};
      receipt=await composePrivateActionPreview({bundle,sourceDate,io,now,loadContext,readSharesight});
    }else{
      // A confirmed read/auth rejection is a missing source, not a zero order
      // book. Unknown credential persistence or identity/integrity failure was
      // stopped above. Sharesight/CALL may still produce truthful partial UI.
      await loadContext({now});
      const snapshotReader=createEodSnapshotReader({sourceDate,readSharesightBatch:async date=>readSharesight(date,await io.loadGatewayToken(),{now,settle:true})});
      receipt=await runPrivateEodReport({sourceDate,io,now,loadContext,fieldMode:true,assumeSharesightSynchronized:true,initialStartedAt:Date.parse(probe.startedAt),readArchive:null,verifyArchive:null,snapshotReader,
        captureOptionalLive:async()=>({...ibSummary(probe),status:'failed'})});
    }
    guardComposition();mirrorAllowed=true;
    // No raw source GET. Known create-only pointer is a copy of the existing
    // metadata-only receipt; actual HTML stays private in its original object.
    const saved=await io.savePrivate(prefix+'preview-receipt.json',receipt);
    guardComposition();
    if(saved.sha256!==digest(receipt))throw fixedError('PRIVATE_PREVIEW_EVIDENCE_UNCONFIRMED');
    if(dailyDelivery){
      dailyCompletionAllowed=true;
      await saveCompletedDailyReport({io,plan,receipt,html});
      guardComposition();
    }
    return {status:'generated',mode:'private-action-preview-once',code:'PRIVATE_ACTION_PREVIEW_GENERATED',dataDate:request.dataDate,sourceDate,startedAt,completedAt:new Date(now()).toISOString(),requestId:request.requestId,execution:env.CLOUD_RUN_EXECUTION,
      ib:ibSummary(probe),sharesightGets,fieldErrors:receipt.fieldErrors,previewReceiptSha256:saved.sha256,reportSha256:receipt.artifact.sha256,financialCompleteness:'not-asserted',interactiveDelivery:'not-published',
      ...(dailyDelivery?{dailyDelivery:'staged'}:{})};
  }catch(error){
    const timeout=['AbortError','TimeoutError'].includes(error?.name)||totalController.signal.aborted||compositionController?.signal.aborted;
    const sourceSafe=phase==='preflight'?safeIbFailure(error):null;
    return {status:'failed',mode:'private-action-preview-once',code:timeout?'PRIVATE_PREVIEW_TIMEOUT':controlledCodes.has(error?.previewCode)?error.previewCode:sourceSafe?.code!=='IB_DIAGNOSTIC_FAILED'&&sourceSafe?.code?sourceSafe.code:'PRIVATE_PREVIEW_COMPOSITION_FAILED',phase,startedAt,completedAt:new Date(now()).toISOString(),upstreamAttempted:probe?.upstreamAttempted??false,previewGenerated:false,...(probe?{ib:ibSummary(probe)}:{})};
  }finally{clearTimeout(totalTimer);clearTimeout(compositionTimer);compositionController?.abort();totalController.abort();source=null;probeReceipt=null;}
}
export async function privatePreviewOnceCli(args,options={}){
  if(args.length!==2||!['--request','--daily-request'].includes(args[0]))return {status:'failed',code:'PRIVATE_PREVIEW_REQUEST_INVALID',upstreamAttempted:false};
  let request;try{request=JSON.parse(args[1]);}catch{return {status:'failed',code:'PRIVATE_PREVIEW_REQUEST_INVALID',upstreamAttempted:false};}
  return runPrivateActionPreviewOnce({...options,request,dailyDelivery:args[0]==='--daily-request'});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))privatePreviewOnceCli(process.argv.slice(2)).then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='failed')process.exitCode=1;
}).catch(()=>{process.stdout.write(JSON.stringify({status:'failed',code:'PRIVATE_PREVIEW_COMPOSITION_FAILED',previewGenerated:false})+'\n');process.exitCode=1;});
