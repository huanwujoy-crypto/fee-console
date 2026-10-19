// Explicit protected private-delivery controller. No schedule, identity grant,
// broker call or public financial projection is activated by importing this file.
import crypto from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planPreopen} from './calendar.mjs';
import {loadTrustedContext,safeErrorOrigin} from './report.mjs';
import {ownerSourceFetch} from './owner_source_bytes.mjs';
import {types as nodeTypes} from 'node:util';
import {boundedText,attachOwnerReadDiagnostics,safeOwnerReadDiagnostics,createOwnerFailureEvidence,safeOwnerFailureEvidence,ownerReadRequestClass} from './cloud_io.mjs';
import {validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {OWNER_SCOPE,createOwnerLatestPublisher} from './owner_latest.mjs';
import {createOwnerLatestStore} from './owner_latest_store.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256,prepareOwnerStaticDisplay,createProtectedOwnerVerifier} from './owner_latest_admission.mjs';
import {EOD_SOURCE_CONFIG,validateEodSourceConfiguration} from './eod_source_config.mjs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
import {createProtectedOwnerPreviewVerifier,prepareAcceptedPreviewDisplay,buildAcceptedPreviewMetadata,createAcceptedPreviewPublisher,
  PREVIEW_REPLACEMENT_REGISTRATION_PATH,validatePreviewReplacementRegistration,previewReplacementRegistrationText,acceptedPreviewRegistrationText,
  createProtectedPreviewReplacementVerifier,createAcceptedPreviewReplacementPublisher,PREVIEW_REPLACEMENT_RESULT_STATUSES,PREVIEW_REPLACEMENT_RESULT_CODES,
  PREVIEW_REPLACEMENT_FAILURE_STAGES,PREVIEW_REPLACEMENT_FAILURE_REASONS} from './owner_accepted_preview.mjs';

const API='https://api.github.com/repos/huanwujoy-crypto/fee-console';
const RAW='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console';
// A saved preview's ancestry response includes the intervening public diff.
// Bound that comparison separately; individual protected files retain 500 kB.
const PREVIEW_COMPARE_MAX_BYTES=2*1024*1024;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const gitBlob=text=>{const b=Buffer.from(text);return crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');};
const fail=(code,origin)=>{const error=Error('OWNER_DELIVERY_'+code);throw Object.assign(error,{safeCode:error.message,safeOrigin:origin??safeErrorOrigin(error)});};
export const OWNER_PREVIEW_REGISTRATION_PATH='security/xuan-owner-accepted-preview.json';
export const OWNER_PROTECTED_SOURCE_PATHS=Object.freeze([
  ...['owner_latest.mjs','owner_latest_store.mjs','owner_latest_admission.mjs','owner_latest_delivery.mjs','owner_accepted_preview.mjs','owner_preview_access.mjs','owner_sdk_transport.mjs','owner_sdk_transport.py','owner_source_bytes.mjs','cloud_io.mjs','report.mjs'].map(file=>'cloud/xuan-preopen/'+file),
  OWNER_PREVIEW_REGISTRATION_PATH,PREVIEW_REPLACEMENT_REGISTRATION_PATH,'security/xuan-owner-approved-audience.json','security/xuan-owner-registered-canary.json',
]);

// The historical phase reads the original trusted Git version, never today's
// context relabelled as yesterday. The current main must still contain it.
export function createOwnerContextLoader({fetchImpl=ownerSourceFetch,now=Date.now,configuration=EOD_SOURCE_CONFIG}={}){
  const read=async (url,signal,limit=500000,diagnostics)=>{
    const started=performance.now();let r,readStage='fetch';
    try{
      try{signal?.throwIfAborted();r=await fetchImpl(url,{redirect:'error',cache:'no-store',headers:{'User-Agent':'xuan-owner-private-delivery'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
      catch(error){try{if(error&&!nodeTypes.isProxy(error))Object.defineProperty(error,'safeOrigin',{value:safeErrorOrigin(error),enumerable:true,configurable:true});}catch{}throw error;}
      readStage='http';if(!r.ok)fail('CONTEXT_HTTP',safeErrorOrigin(new Error(),r));
      readStage='body';const body={},text=await boundedText(r,limit,body);
      if(diagnostics)diagnostics.value=safeOwnerReadDiagnostics({...body.value,requestClass:ownerReadRequestClass(url),elapsedMs:Math.max(0,Math.floor(performance.now()-started)),timeoutMs:15000});
      return text;
    }catch(error){
      try{
      const evidence=createOwnerFailureEvidence(error);
      attachOwnerReadDiagnostics(error,{requestClass:ownerReadRequestClass(url),readStage,httpStatus:r?safeErrorOrigin(null,r).httpStatus:null,bodyLimitBytes:limit,
        elapsedMs:Math.max(0,Math.floor(performance.now()-started)),timeoutMs:15000,origin:evidence.read?.origin??evidence.origin});
      }catch{}
      throw error;
    }
  };
  const json=(text,diagnostics)=>{try{return JSON.parse(text);}catch(error){if(diagnostics)attachOwnerReadDiagnostics(error,{...diagnostics,origin:safeErrorOrigin(error,diagnostics.httpStatus)});throw error;}};
  const parsedFailure=(code,error,diagnostics)=>{try{fail(code);}catch(wrapped){if(diagnostics)attachOwnerReadDiagnostics(wrapped,{...diagnostics,origin:safeErrorOrigin(error,diagnostics.httpStatus)});throw wrapped;}};
  return async ({phase='candidate-admission',policyCommit,registrationSha256,now:clock=now,signal}={})=>{
    signal?.throwIfAborted();
    const current=await loadTrustedContext({fetchImpl,now:clock,signal});
    signal?.throwIfAborted();
    let eodConfiguration=null;
    try{eodConfiguration={...validateEodSourceConfiguration(configuration),account:APPROVED_IB_ACCOUNT_ID};}catch{}
    if(phase==='candidate-admission')return {...current,eodConfiguration};
    if(['accepted-preview-admission','accepted-preview-historical','accepted-preview-replacement'].includes(phase)){
      if(!/^[a-f0-9]{40}$/.test(policyCommit||''))fail('PREVIEW_CONTEXT');
      const currentCommit=current.association.policyCommit;
      if(phase!=='accepted-preview-historical'&&policyCommit!==currentCommit)fail('PREVIEW_CURRENT_CONTEXT');
      if(policyCommit!==currentCommit){
        const diagnostics={};
        const comparison=json(await read(API+'/compare/'+policyCommit+'...'+currentCommit,signal,PREVIEW_COMPARE_MAX_BYTES,diagnostics),diagnostics.value);
        if(!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==policyCommit)fail('PREVIEW_ANCESTRY');
      }
      const currentDiagnostics={},originalDiagnostics=policyCommit===currentCommit?currentDiagnostics:{};
      const currentText=await read(RAW+'/'+currentCommit+'/'+OWNER_PREVIEW_REGISTRATION_PATH,signal,500000,currentDiagnostics);
      const originalText=policyCommit===currentCommit?currentText:await read(RAW+'/'+policyCommit+'/'+OWNER_PREVIEW_REGISTRATION_PATH,signal,500000,originalDiagnostics);
      if(sha(currentText)!==sha(originalText))fail('PREVIEW_REGISTRATION_CHANGED');
      let registration;try{parseDecisionJson(originalText,128*1024);registration=JSON.parse(originalText);}catch(error){parsedFailure('PREVIEW_REGISTRATION_JSON',error,originalDiagnostics.value);}
      if(phase==='accepted-preview-replacement'||registrationSha256!==undefined&&registrationSha256!==sha(originalText)){
        const revisionDiagnostics={},originalRevisionDiagnostics=policyCommit===currentCommit?revisionDiagnostics:{};
        const revisionText=await read(RAW+'/'+currentCommit+'/'+PREVIEW_REPLACEMENT_REGISTRATION_PATH,signal,500000,revisionDiagnostics);
        const originalRevisionText=policyCommit===currentCommit?revisionText:await read(RAW+'/'+policyCommit+'/'+PREVIEW_REPLACEMENT_REGISTRATION_PATH,signal,500000,originalRevisionDiagnostics);
        if(sha(revisionText)!==sha(originalRevisionText))fail('PREVIEW_REPLACEMENT_CHANGED');
        const canaryText=await read(RAW+'/'+currentCommit+'/security/xuan-owner-registered-canary.json',signal);
        let revision;try{parseDecisionJson(originalRevisionText,128*1024);revision=JSON.parse(originalRevisionText);
          validatePreviewReplacementRegistration(revision,{previousRegistration:registration,previousRegistrationSha256:sha(originalText),canaryRegistrationSha256:sha(canaryText)});
          if(previewReplacementRegistrationText(revision)!==originalRevisionText)fail('PREVIEW_REPLACEMENT_BYTES');
        }catch(error){parsedFailure('PREVIEW_REPLACEMENT_REGISTRATION',error,originalRevisionDiagnostics.value);}
        const previewReplacement={revision,sha256:sha(originalRevisionText),policyCommit};
        if(phase==='accepted-preview-replacement')return {...current,eodConfiguration,previewReplacement};
        const nextSha=sha(acceptedPreviewRegistrationText(revision.registration));
        if(registrationSha256!==nextSha)fail('PREVIEW_REPLACEMENT_METADATA');
        return {...current,eodConfiguration,previewReplacement,previewRegistration:{registration:revision.registration,sha256:nextSha,policyCommit}};
      }
      return {...current,eodConfiguration,previewRegistration:{registration,sha256:sha(originalText),policyCommit}};
    }
    if(phase!=='historical-authenticity'||!/^[a-f0-9]{40}$/.test(policyCommit||''))fail('HISTORICAL_CONTEXT');
    const comparisonDiagnostics={};
    const comparison=json(await read(API+'/compare/'+policyCommit+'...'+current.association.policyCommit,signal,500000,comparisonDiagnostics),comparisonDiagnostics.value);
    if(!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==policyCommit)fail('HISTORICAL_ANCESTRY');
    const paths=['claude/xuan-ib-account-association-v1.json','claude/xuan-ib-etf-pending-calls-v1.json','xuan-ib/latest.meta.json','xuan-ib/latest.html'];
    const sourceDiagnostics=paths.map(()=>({}));
    const [policyText,ledgerText,metaText,previousHtml]=await Promise.all(paths.map((p,index)=>read(RAW+'/'+policyCommit+'/'+p,signal,500000,sourceDiagnostics[index])));
    const meta=json(metaText,sourceDiagnostics[2].value);
    if(!/^[a-f0-9]{40}$/.test(meta.sourceSha||'')||gitBlob(previousHtml)!==meta.htmlBlob)fail('HISTORICAL_PUBLIC_BINDING');
    const association={policy:json(policyText,sourceDiagnostics[0].value),policyCommit,policyBlob:gitBlob(policyText),checkedAt:new Date(clock()).toISOString()};
    // Time validity is checked at the original receipt time by the verifier.
    validateAssociationSnapshot(association,{now:clock(),edition:'am',requireActive:false});
    return {association,reserveLedger:json(ledgerText,sourceDiagnostics[1].value),reserveHash:sha(ledgerText),previousMeta:meta,previousSourceSha:meta.sourceSha,previousHtml,eodConfiguration};
  };
}

// Only an existing Google credential is used. No token endpoint, SDK login,
// Secret Manager, impersonation or arbitrary credential reader exists here.
export function ownerDeliveryRequest(token,fetchImpl=fetch){
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('EXISTING_IDENTITY_REQUIRED');
  return async (url,options={})=>{
    const u=new URL(url);
    if(u.origin!=='https://storage.googleapis.com')fail('TRANSPORT_ORIGIN');
    return fetchImpl(url,{...options,redirect:'error',headers:{...options.headers,Authorization:'Bearer '+token}});
  };
}

export function ownerBundleMetadata(bundle,receipt){
  const model=extractNightActionModel(new TextDecoder('utf-8',{fatal:true}).decode(bundle.html));
  return {schema:'xuan.owner-latest.v1',scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,
    dataDate:receipt.dataDate,sourceDate:receipt.sourceDate,captureStartedAt:receipt.startedAt,captureEndedAt:receipt.completedAt,completedAt:receipt.completedAt,
    artifactObject:bundle.artifactObject,artifactGeneration:bundle.artifactGeneration,artifactSha256:bundle.artifactSha256,
    receiptObject:bundle.receiptObject,receiptGeneration:bundle.receiptGeneration,receiptSha256:bundle.receiptSha256,
    financialStatus:'partial',unknownFields:[...(model.orders.status==='ready'?[]:['orders']),...(model.holdings?.status==='ready'?[]:['holdings']),...(model.allocation.status==='ready'?[]:['allocation']),'cash','prices']};
}

export async function deliverOwnerLatest({request,now=Date.now,loadContext=createOwnerContextLoader({now}),
  storeFactory=createOwnerLatestStore,publisherFactory=createOwnerLatestPublisher,expectedArtifactSha256=null,expectedReceiptSha256=null}={}){
  const plan=planPreopen(now());
  if(plan.status!=='generate')return {status:'no-action',reason:plan.reason};
  if(typeof request!=='function')fail('TRANSPORT_REQUIRED');
  const io=storeFactory({request});
  const bundle=await io.readDailyBundle({dataDate:plan.dataDate});
  if(!bundle||!(bundle.html instanceof Uint8Array)||!(bundle.receipt instanceof Uint8Array))fail('BUNDLE_REQUIRED');
  if(expectedArtifactSha256!==null&&bundle.artifactSha256!==expectedArtifactSha256
    ||expectedReceiptSha256!==null&&bundle.receiptSha256!==expectedReceiptSha256)fail('COLLECTED_BUNDLE_CHANGED');
  let receipt;try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bundle.receipt));}catch{fail('RECEIPT_JSON');}
  if(receipt.dataDate!==plan.dataDate||receipt.sourceDate!==plan.sourceDate||receipt.artifact?.privateObject!==bundle.artifactObject
    ||receipt.artifact?.generation!==bundle.artifactGeneration||receipt.artifact?.sha256!==bundle.artifactSha256)fail('DAILY_BINDING');
  const verifyProtectedReceipt=createProtectedOwnerVerifier({loadContext,readPinnedSource:pin=>io.readPinnedSource(pin),now});
  const verifyProtectedPreview=createProtectedOwnerPreviewVerifier({loadContext,now});
  const publisher=publisherFactory({io,ownerBinding:OWNER_BINDING,verifyProtectedReceipt,verifyProtectedPreview,prepareDisplay:prepareOwnerStaticDisplay,now});
  return publisher.publish({metadata:ownerBundleMetadata(bundle,receipt),html:bundle.html,receipt:bundle.receipt});
}

export const createOwnerDeliveryHook=options=>async({html,receiptText})=>{
  if(typeof html!=='string'||typeof receiptText!=='string')fail('COLLECTED_BYTES_REQUIRED');
  return deliverOwnerLatest({...options,expectedArtifactSha256:sha(html),expectedReceiptSha256:sha(receiptText)});
};

// Explicit review-preview entry only. There is no weekend daily flag or default
// access assertion. The trusted executor must supply an actual read-only access
// checker after the separately authorized audience and canary are verified.
// A local/unmerged candidate fails before the private transport is constructed.
export async function deliverOwnerAcceptedPreview({cwd,request,html,modelBytes,manifestBytes,verifyDestinationAccess,
  now=Date.now,loadContext=createOwnerContextLoader({now}),storeFactory=createOwnerLatestStore,
  publisherFactory=createAcceptedPreviewPublisher}={}){
  const head=await requireProtectedOwnerCheckout({cwd,loadContext,now});
  if(typeof request!=='function'||typeof verifyDestinationAccess!=='function')fail('PREVIEW_ACCESS_CAPABILITY_REQUIRED');
  const context=await loadContext({phase:'accepted-preview-admission',policyCommit:head,now});
  const registered=context?.previewRegistration;
  if(!registered||registered.policyCommit!==head)fail('PREVIEW_CURRENT_CONTEXT');
  const displayBytes=await prepareAcceptedPreviewDisplay(html,{modelBytes,manifestBytes,registration:registered.registration});
  const metadata=await buildAcceptedPreviewMetadata({registration:registered.registration,registrationSha256:registered.sha256,registrationPolicyCommit:head});
  const io=storeFactory({request});
  const publisher=publisherFactory({io,verifyProtectedPreview:createProtectedOwnerPreviewVerifier({loadContext,now}),verifyDestinationAccess,now});
  return publisher.publish({metadata,displayBytes});
}

// Explicit local owner replacement only, after the reviewed transition has
// reached protected main. No CLI, schedule or permission grant is added.
export async function deliverOwnerAcceptedPreviewReplacement({cwd,request,requestPreviewReplacement,html,modelBytes,manifestBytes,verifyDestinationAccess,
  now=Date.now,loadContext=createOwnerContextLoader({now}),storeFactory=createOwnerLatestStore,publisherFactory=createAcceptedPreviewReplacementPublisher}={}){
  const diagnostics={schema:'xuan.owner-publication.safe-diagnostics.v1',businessAckValidated:0,independentReadbackAttempts:0,storeReadbackCompleted:0,fullVerification:null,
    resultStatus:null,resultCode:null,failureStage:null,failureReason:null};
  const attach=value=>{try{if(value&&!nodeTypes.isProxy(value))Object.defineProperty(value,'ownerPublicationDiagnostics',{value:Object.freeze({...diagnostics}),enumerable:false});}catch{}return value;};
  try{
  const head=await requireProtectedOwnerCheckout({cwd,loadContext,now});
  if(typeof request!=='function'||typeof requestPreviewReplacement!=='function'||typeof verifyDestinationAccess!=='function')fail('PREVIEW_REPLACEMENT_ACCESS_REQUIRED');
  const p=(await loadContext({phase:'accepted-preview-replacement',policyCommit:head,now}))?.previewReplacement;
  if(!p||p.policyCommit!==head||sha(previewReplacementRegistrationText(p.revision))!==p.sha256)fail('PREVIEW_REPLACEMENT_CURRENT_CONTEXT');
  const registration=p.revision.registration,displayBytes=prepareAcceptedPreviewDisplay(html,{modelBytes,manifestBytes,registration});
  const metadata=buildAcceptedPreviewMetadata({registration,registrationSha256:sha(acceptedPreviewRegistrationText(registration)),registrationPolicyCommit:head});
  const originalIo=storeFactory({request,requestPreviewReplacement});
  let io=originalIo;
  if(originalIo&&typeof originalIo==='object'){
    io=Object.fromEntries(Object.entries(originalIo).map(([key,value])=>[key,typeof value==='function'?value.bind(originalIo):value]));
    if(typeof originalIo.replaceAcceptedPreview==='function')io.replaceAcceptedPreview=async(...args)=>{const ack=await Reflect.apply(originalIo.replaceAcceptedPreview,originalIo,args);diagnostics.businessAckValidated=1;return ack;};
    if(typeof originalIo.readLatestGeneration==='function')io.readLatestGeneration=async(...args)=>{if(diagnostics.businessAckValidated)diagnostics.independentReadbackAttempts=1;const bytes=await Reflect.apply(originalIo.readLatestGeneration,originalIo,args);if(diagnostics.businessAckValidated)diagnostics.storeReadbackCompleted=1;return bytes;};
  }
  const result=await publisherFactory({io,verifyProtectedReplacement:createProtectedPreviewReplacementVerifier({loadContext,now}),verifyDestinationAccess,now}).publish({metadata,displayBytes});
  // Only finite own-data labels from the original publisher survive. An attempt
  // flag never substitutes for an HTTP write or validated business ACK counter.
  if(result&&['object','function'].includes(typeof result)&&!nodeTypes.isProxy(result)){
    const own=key=>{const descriptor=Object.getOwnPropertyDescriptor(result,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
    const status=own('status');
    if(status==='published-verified')diagnostics.fullVerification=true;
    else {
    for(const [key,allowed] of [['resultStatus',PREVIEW_REPLACEMENT_RESULT_STATUSES],['resultCode',PREVIEW_REPLACEMENT_RESULT_CODES],
      ['failureStage',PREVIEW_REPLACEMENT_FAILURE_STAGES],['failureReason',PREVIEW_REPLACEMENT_FAILURE_REASONS]]){
      const value=own(key==='resultStatus'?'status':key==='resultCode'?'code':key);if(allowed.includes(value))diagnostics[key]=value;
    }
    const evidence=safeOwnerFailureEvidence(own('failureEvidence'));if(evidence)diagnostics.failureEvidence=evidence;
    }
  }
  return attach(result);
  }catch(error){
    try{
      let existing;
      if(error&&['object','function'].includes(typeof error)&&!nodeTypes.isProxy(error)){
        const descriptor=Object.getOwnPropertyDescriptor(error,'failureEvidence');
        if(descriptor&&Object.hasOwn(descriptor,'value'))existing=safeOwnerFailureEvidence(descriptor.value);
      }
      const evidence=existing??createOwnerFailureEvidence(error);
      if(evidence)diagnostics.failureEvidence=evidence;
    }catch{}
    attach(error);throw error;
  }
}

// Named storage-only result: the original publisher must first finish its
// independent pinned bytes/metadata readback. This never accepts visual UI.
export async function deliverOwnerAcceptedPreviewReplacementStorage(options={}){
  const reject=()=>{throw Object.assign(Error('OWNER_DELIVERY_STORAGE_ARGUMENTS_FORBIDDEN'),{safeCode:'STORAGE_DELIVERY_ARGUMENTS_FORBIDDEN'});};
  const keys=['cwd','request','requestPreviewReplacement','html','modelBytes','manifestBytes','verifyDestinationAccess'];
  let values;
  try{
    if(arguments.length>1||!options||Object.getPrototypeOf(options)!==Object.prototype)reject();
    const descriptors=Object.getOwnPropertyDescriptors(options);
    if(Reflect.ownKeys(descriptors).some(key=>!keys.includes(key)||!Object.hasOwn(descriptors[key],'value')))reject();
    values=Object.fromEntries(keys.map(key=>[key,descriptors[key]?.value]));
  }catch{reject();}
  const {cwd,request,requestPreviewReplacement,html,modelBytes,manifestBytes,verifyDestinationAccess}=values;
  const result=await deliverOwnerAcceptedPreviewReplacement({cwd,request,requestPreviewReplacement,html,modelBytes,manifestBytes,verifyDestinationAccess});
  if(result.status!=='published-verified')return result;
  const stored={...result,status:'stored-verified-visual-pending',storageStatus:'verified',visualStatus:'pending',acceptanceComplete:false};
  const diagnostics=Object.getOwnPropertyDescriptor(result,'ownerPublicationDiagnostics');
  if(diagnostics&&Object.hasOwn(diagnostics,'value'))Object.defineProperty(stored,'ownerPublicationDiagnostics',{value:diagnostics.value,enumerable:false});
  return stored;
}

// The new publisher cannot run from an unmerged local candidate. The CLI checks
// actual trusted main before reading its existing credential environment.
export async function requireProtectedOwnerCheckout({cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),loadContext=createOwnerContextLoader(),now=Date.now,signal}={}){
  signal?.throwIfAborted();
  const context=await loadContext({now,...(signal?{signal}:{})});
  signal?.throwIfAborted();
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
  if(head!==context.association.policyCommit||execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd,encoding:'utf8'}).trim())fail('PROTECTED_CHECKOUT_REQUIRED');
  for(const relative of OWNER_PROTECTED_SOURCE_PATHS){
    const committed=execFileSync('git',['rev-parse','HEAD:'+relative],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    const local=execFileSync('git',['hash-object',relative],{cwd,encoding:'utf8'}).trim();
    if(committed!==local)fail('PROTECTED_SOURCE_BYTES_REQUIRED');
  }
  return head;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--execute-current-workday')fail('EXPLICIT_EXECUTION_REQUIRED');
    const plan=planPreopen(Date.now());
    if(plan.status!=='generate'){process.stdout.write(JSON.stringify({status:'no-action',reason:plan.reason})+'\n');}
    else{
      await requireProtectedOwnerCheckout();
      const result=await deliverOwnerLatest({request:ownerDeliveryRequest(process.env.XUAN_PREOPEN_GOOGLE_TOKEN)});
      process.stdout.write(JSON.stringify(result)+'\n');
      if(!['published-verified','no-op','written-verified'].includes(result.status))process.exitCode=1;
    }
  }catch{process.stderr.write('OWNER_PRIVATE_DELIVERY_BLOCKED\n');process.exitCode=1;}
}
