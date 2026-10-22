import {normalizeBrowserSnapshot,SHARESIGHT_BROWSER_SOURCE,SHARESIGHT_VALUATION_DATE_BASIS} from './eod_sources.mjs';
// Pure admission/static export. No default transport, credentials, source call,
// storage mutation or live entry. The controller must supply authenticated,
// generation-pinned private reads and freshly read trusted Git contexts.
import crypto from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {ownerBundlePathsMatch,recoveryRequestId} from './owner_bundle_contract.mjs';
import {registeredOwnerRecovery,registeredReferenceCapture,registeredHistoricalReferenceCapture,registeredDisplayReferenceCapture,ownerCaptureDeadline,validateReferenceSources} from './owner_source_recovery.mjs';
import {validateEodReceipt,validateCompletedEodSession} from './eod_report.mjs';
import {adaptFlexArchive,digest,SNAPSHOT_SCOPES} from './eod_sources.mjs';
import {resolveCurrentCall} from './call_record.mjs';
import {uniqueCloudJson,createOwnerFailureEvidence} from './cloud_io.mjs';
import {inspectOrdersAccountEvidence} from './orders_probe.mjs';
import {buildEodActionModel,SHARESIGHT_BOOK_BASIS,actionUnknownFields} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {validateAssociationPolicy,validateAssociationSnapshot,validateAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
import {APPROVED_IB_ACCOUNT_ID,fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';

export const OWNER_SCOPE='ib-hk-classified-stocks__cash-ib-hk-noah-hk__orders-ib.v1';
export const OWNER_BINDING=digest({provider:'github',owner:'huanwujoy-crypto',immutableOwnerId:283054367});
const IB_SNAPSHOT_SCOPE=SNAPSHOT_SCOPES['sharesight.ibGroupedPerformance'],NOAH_SNAPSHOT_SCOPE=SNAPSHOT_SCOPES['sharesight.noahPerformance'];
export const SOURCE_IDENTITY_SHA256=digest({scope:OWNER_SCOPE,ibAccount:APPROVED_IB_ACCOUNT_ID,
  sharesightStocks:{portfolioId:IB_SNAPSHOT_SCOPE.portfolioId,grouping:Number(IB_SNAPSHOT_SCOPE.grouping)},
  sharesightCash:[IB_SNAPSHOT_SCOPE.portfolioId,NOAH_SNAPSHOT_SCOPE.portfolioId],currency:'USD',ibMode:'mcp.read'});
export const OWNER_DISPLAY_CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MAX_HTML=2*1024*1024,MAX_RECEIPT=131072,MAX_SOURCE=8000000;
const HASH=/^[a-f0-9]{64}$/,GEN=/^[1-9][0-9]{0,29}$/;
const KEYS=['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive'];
const fail=code=>{throw Object.assign(Error('OWNER_ADMISSION_'+code),{safeCode:'OWNER_ADMISSION_'+code});};
const object=o=>o&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(o,keys)=>object(o)&&Object.keys(o).sort().join('|')===[...keys].sort().join('|');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
function bytesCopy(value,limit){
  if(!(value instanceof Uint8Array)||!value.byteLength||value.byteLength>limit)fail('BYTES');
  return new Uint8Array(value);
}
function decode(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UTF8');}}
function parsed(bytes,limit){try{return uniqueCloudJson(decode(bytes),limit);}catch{fail('JSON');}}
const hktMinute=s=>new Date(Date.parse(s)+28800000).toISOString().slice(11,16);
function reportCaptureWindow(model,r){
  if(!instant(r.startedAt)||!instant(r.completedAt)||r.startedAt>r.completedAt)fail('TIMES');
  if(new Date(Date.parse(r.startedAt)+28800000).toISOString().slice(0,10)!==r.dataDate)fail('REPORT_TIME_BINDING');
  let completedAt=r.completedAt,headerEndMinute;
  if(model.fieldState){
    const capture=model.provenance.capture;
    if(!instant(capture?.startedAt)||!instant(capture?.completedAt)||capture.startedAt!==r.startedAt
      ||capture.completedAt<capture.startedAt||capture.completedAt>r.completedAt)fail('MODEL_CAPTURE_BINDING');
    completedAt=capture.completedAt;headerEndMinute=Math.floor(Date.parse(completedAt)/60000);
  }else{
    // The standard producer records its collection end in the minute header,
    // then persists sources/HTML before receipt.completedAt. It has no separate
    // pinned exact collection-end or Flex-read instant. Authenticate only that
    // provable window, never invent an independent timestamp or equate saving
    // completion with collection completion when those cross a minute.
    const match=model.asOfHkt.match(/^\d{4}-\d\d-\d\d \d\d:\d\d–(\d\d:\d\d) HKT · 数据至 \d{4}-\d\d-\d\d$/);
    if(!match)fail('REPORT_TIME_BINDING');
    headerEndMinute=Date.parse(r.dataDate+'T'+match[1]+':00+08:00')/60000;
    if(!Number.isInteger(headerEndMinute)||headerEndMinute<Math.floor(Date.parse(r.startedAt)/60000)
      ||headerEndMinute>Math.floor(Date.parse(r.completedAt)/60000))fail('REPORT_TIME_BINDING');
  }
  const asOfHkt=`${r.dataDate} ${hktMinute(r.startedAt)}–${hktMinute(new Date(headerEndMinute*60000).toISOString())} HKT · 数据至 ${r.sourceDate}`;
  if(model.asOfHkt!==asOfHkt)fail('REPORT_TIME_BINDING');
  return {startedAt:r.startedAt,completedAt,headerEndMinute,asOfHkt};
}
function sourceReadTime(readAt,window,code){
  if(!instant(readAt)||readAt<window.startedAt||readAt>window.completedAt
    ||Math.floor(Date.parse(readAt)/60000)>window.headerEndMinute)fail(code);
}
function admittedModel(html){
  let model;
  try{model=extractNightActionModel(html);validateNightActionHtml(html,model.dataDate);}
  catch{fail('CANONICAL_HTML');}
  const book=model.calculationBasis===SHARESIGHT_BOOK_BASIS;
  if(model.schemaVersion!==9||model.mode!=='eod-action'||model.cash.executableBudget!==null
    ||!book&&(model.status!=='partial'||model.cash.orderReserve!==null||model.cash.planning!==null||model.replenishment.status!=='unavailable'))fail('PARTIAL_SCOPE');
  return model;
}

/** Derive display bytes only from an exact canonical main-renderer report.
 * No DOMParser/fake DOM is used on the server. Replacements are constrained to
 * the renderer's already validated fixed output; no arbitrary HTML is cleaned.
 * Original model, receipt and artifact hashes remain separate from displayHash.
 */
export function prepareOwnerStaticDisplay(input){
  const html=decode(bytesCopy(input,MAX_HTML)),model=admittedModel(html);
  let display=renderNightActionReport(model);
  // schema9 non-field reports have precisely one known status updater. Their
  // original bytes were independently reproduced above before removing it.
  const scripts=[...display.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if(scripts.length!==(model.fieldState?0:1))fail('STATIC_SCRIPT_SHAPE');
  if(scripts.length&&(!scripts[0][1].startsWith('(()=>{const state=')||!scripts[0][1].includes('setInterval(check,30000)')))fail('STATIC_SCRIPT_SHAPE');
  display=display.replace(/<script>[\s\S]*?<\/script>/g,'');
  if(/<script\b|<iframe\b|<form\b|<object\b|<embed\b|<img\b|<link\b|\son[a-z]+\s*=|@import|url\s*\(/i.test(display))fail('STATIC_ACTIVE_CONTENT');
  const cards=[['card-plan','本轮补仓'],['card-orders','挂单提醒'],['card-cash','现金优先补仓参考'],['card-allocation','股票四类配置']];
  if((display.match(/<section class="card">/g)||[]).length!==4)fail('STATIC_CARD_SHAPE');
  for(const [id,title] of cards){const needle='<section class="card"><h2>'+title;
    if(display.split(needle).length!==2)fail('STATIC_CARD_SHAPE');
    display=display.replace(needle,`<section class="card" id="${id}"><h2>${title}`);
  }
  // The schema9 order model has no native currency/contract-evidence member.
  // Preserve the displayed reference facts while explicitly refusing to turn
  // ticker/position matching into native order currency or contract identity.
  display=display.replaceAll('class="distance">','class="distance" title="参考价差；同名持仓匹配，原生订单合约未核实">');
  display=display.replace(/(<div class="quote"><b>[^<]*<\/b><span>)([A-Z]{3})(<\/span>)/g,'$1$2·推定$3');
  const disclosure=model.calculationBasis===SHARESIGHT_BOOK_BASIS?'<aside class="notes" role="note"><p>私有只读报告；报告日、来源日和取数时间保持不变。按用户同步前提估算 Sharesight 账面预算。挂单币种与价差按关联持仓推定；覆盖或币种缺项时不计算净预算。所有结果均非券商实时可下单额。</p></aside>':'<aside class="notes" role="note"><p>私有只读报告；原报告日、来源日和取数时间保持不变。挂单所列币种及距市价仅为同名持仓匹配参考；原生挂单币种、合约 ID 与市场身份尚未核实，不能据此认定完整预留或可执行预算。</p></aside>';
  const reference=registeredDisplayReferenceCapture(model.provenance?.capture?.startedAt,model.provenance?.capture?.completedAt);
  const referenceNotice=reference?'<aside class="notes" role="note"><p>一次性参考快照，非实时数据。原始采集时间 '+reference.captureStartedAt+' 至 '+reference.captureCompletedAt+'；允许发布截止 '+reference.expiresAt+'。采集后价格、现金或挂单可能已变化。</p></aside>':'';
  display=display.replace('</header>','</header>'+referenceNotice+(Object.hasOwn(model,'observedOrderPlan')?disclosure.replace('覆盖或币种缺项时不计算净预算。','完整覆盖或币种缺项时不声称完整净预算；按已取得买单计算的参考估算单独注明。'):disclosure));
  display=display.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+OWNER_DISPLAY_CSP+'"><meta name="referrer" content="no-referrer"><style>.quote span{font-size:10px;white-space:nowrap}</style>');
  if(!display.includes(OWNER_DISPLAY_CSP)||/<script\b/i.test(display))fail('STATIC_EXPORT');
  return new TextEncoder().encode(display);
}

function metadataBinding(m,r,htmlBytes,receiptBytes,model,time){
  const keys='schema scope ownerBinding sourceIdentitySha256 dataDate sourceDate captureStartedAt captureEndedAt completedAt artifactObject artifactGeneration artifactSha256 receiptObject receiptGeneration receiptSha256 financialStatus unknownFields'.split(' ');
  if(Object.hasOwn(model,'dateBasis'))keys.push('dateBasis');
  if(!exact(m,keys)||m.schema!=='xuan.owner-latest.v1'||m.scope!==OWNER_SCOPE||m.ownerBinding!==OWNER_BINDING
    ||m.sourceIdentitySha256!==SOURCE_IDENTITY_SHA256||m.financialStatus!==(model.calculationBasis===SHARESIGHT_BOOK_BASIS&&model.status==='ready'?'complete':'partial'))fail('METADATA_SCOPE');
  if(m.dataDate!==r.dataDate||m.sourceDate!==r.sourceDate||m.dataDate!==model.dataDate||m.sourceDate!==model.sourceDate
    ||m.dateBasis!==r.dateBasis||m.dateBasis!==model.dateBasis
    ||!ownerBundlePathsMatch(m)
    ||r.artifact?.privateObject!==m.artifactObject||r.artifact.generation!==m.artifactGeneration
    ||!GEN.test(m.artifactGeneration)||!GEN.test(m.receiptGeneration)||m.artifactSha256!==sha(htmlBytes)
    ||m.receiptSha256!==sha(receiptBytes)||r.artifact.sha256!==m.artifactSha256)fail('METADATA_BINDING');
  const captureEnd=r.captureCompletedAt??r.completedAt;
  if(!instant(r.startedAt)||!instant(r.completedAt)||!instant(captureEnd)||captureEnd<r.startedAt||captureEnd>r.completedAt
    ||m.captureStartedAt!==r.startedAt||m.captureEndedAt!==captureEnd
    ||m.completedAt!==r.completedAt||r.startedAt>r.completedAt||Date.parse(r.completedAt)>time)fail('TIMES');
  if(Date.parse(captureEnd)-Date.parse(r.startedAt)>300000)fail('CAPTURE_WINDOW');
  reportCaptureWindow(model,r);
  const unknowns=m.unknownFields,allowed=['orders','holdings','cash','allocation','prices','sourceIdentity','freshness'];
  const required=actionUnknownFields(model);
  if(!Array.isArray(unknowns)||(m.financialStatus==='partial'&&!unknowns.length)||(m.financialStatus==='complete'&&unknowns.length)||unknowns.length>allowed.length||new Set(unknowns).size!==unknowns.length
    ||unknowns.some(k=>!allowed.includes(k))||required.some(k=>!unknowns.includes(k)))fail('UNKNOWN_FIELDS');
}
function callBinding(context,model){
  const call=resolveCurrentCall(context.reserveLedger,model.dataDate);
  if(call.status!=='owner-declared'||model.cash.reserve!==Math.round(call.amountUsd*100)/100
    ||model.cash.callApplied!==Math.round(call.amountUsd*50)/100)fail('CALL_BINDING');
  if(model.fieldState&&(model.cash.call.status!==call.status||model.cash.call.declarationDate!==call.declarationDate
    ||model.cash.call.declarationSha256!==call.declarationSha256))fail('CALL_BINDING');
  return call;
}
function contextBinding(context,r,phase,time){
  if(!object(context)||!context.association||typeof context.previousHtml!=='string'||!HASH.test(fingerprint(context.reserveLedger)))fail('CONTEXT');
  if(phase==='historical-authenticity'){
    // The trusted loader must actually fetch and verify this original Git
    // version/ancestor. A current-main response cannot stand in for it.
    if(context.association.policyCommit!==r.association.policyCommit)fail('HISTORICAL_CONTEXT_UNAVAILABLE');
    validateAssociationSnapshot(context.association,{now:time,edition:'am',requireActive:false});
    validateAssociationPolicy(context.association.policy,{now:Date.parse(r.completedAt),edition:'am'});
    if(!instant(r.association.policyCheckedAt)||r.association.policyCheckedAt>r.completedAt)fail('HISTORICAL_ASSOCIATION_TIME');
    // Reassess the saved original association at its own real check instant.
    // This does not invent a historical network lookup at report completion.
    const original={...context.association,checkedAt:r.association.policyCheckedAt};
    validateAssociationReceipt(r.association,original,{now:Date.parse(r.association.policyCheckedAt),edition:'am',
      previousSourceSha:context.previousSourceSha,runId:r.association.runId});
  }else{
    validateAssociationSnapshot(context.association,{now:time,edition:'am'});
    validateAssociationReceipt(r.association,context.association,{now:time,edition:'am',
      previousSourceSha:context.previousSourceSha,runId:r.association.runId});
  }
  return fingerprint({policy:context.association.policy,originalCommit:phase==='historical-authenticity'?context.association.policyCommit:null,
    previousSourceSha:context.previousSourceSha,previousHtml:context.previousHtml,reserveLedger:context.reserveLedger,eodConfiguration:context.eodConfiguration??null});
}
function snapshotSource(key,value,r){
  if(value?.sourceKey!==key||!['date-verified','not-called','request-failure','missing-fields','date-mismatch','malformed','unverified','failed','timeout'].includes(value.status))fail('SNAPSHOT_STATUS_UNSUPPORTED');
  // There is no real completed-sync receipt verifier in main yet. Never
  // promote a self-contained source object's claimed completion into proof.
  if(value.status!=='date-verified'){
    if(Object.hasOwn(value,'raw')||value.rawFingerprint!=null)fail('SNAPSHOT_FAILURE_SHAPE');
    return value;
  }
  const scope=SNAPSHOT_SCOPES[key],report=value.raw?.report??value.raw?.data?.report??value.raw?.result?.data?.report,p=value.provenance;
  const browser=value.raw?.source===SHARESIGHT_BROWSER_SOURCE;
  if(browser){const b=normalizeBrowserSnapshot(value.raw,{portfolioId:scope.portfolioId,sourceDate:r.sourceDate});
    if(digest(b.raw)!==digest(value.raw)||p?.readAt!==b.readAt)fail('BROWSER_SOURCE_BINDING');}
  if(value.raw?.mode!=='read_only'||!(value.raw.source==='Sharesight User API'||browser)||report?.portfolio_id!==scope.portfolioId
    ||report.currency?.code!=='USD'||report.start_date!==r.sourceDate||report.end_date!==r.sourceDate||report.include_sales!==false
    ||(key==='sharesight.ibGroupedPerformance'?(report.grouping!=='custom_group_category'||report.custom_group?.id!==Number(scope.grouping)):report.grouping!==scope.grouping)
    ||value.rawFingerprint!==digest(value.raw)||value.completion!==null||p?.sourceDate!==r.sourceDate||!instant(p.readAt)
    ||p.readAt<r.startedAt||p.readAt>r.completedAt||p.syncCompletedAt!==null||p.snapshotGeneration!==null||p.receiptSha256!==null)fail('SNAPSHOT_BINDING');
  return value;
}
function sourceModel(values,r,model,context,call,concentrationInput=null){
  const window=reportCaptureWindow(model,r);
  const f=values['ib.flexEod'];let flex=null;
  if(f?.archive){
    const cfg=context.eodConfiguration,proof=f.identityProof;
    if(cfg?.account!==APPROVED_IB_ACCOUNT_ID||typeof cfg.configuredQueryId!=='string'||!cfg.configuredQueryId
      ||cfg.baseCurrency!=='USD'||f.financialProof!==null)fail('FLEX_TRUSTED_CONFIG_OR_FINANCIAL_PROOF_UNAVAILABLE');
    if(proof?.status!=='archive-verified'||proof.account!==cfg.account||proof.configuredQueryId!==cfg.configuredQueryId
      ||proof.sourceDate!==r.sourceDate||proof.rawSha256!==digest(f.archive.bytes)||proof.generation!==f.archive.metadata?.generation
      ||f.archive.metadata?.configuredQueryId!==cfg.configuredQueryId||f.archive.metadata?.baseCurrency!==cfg.baseCurrency
      ||f.archive.metadata?.providerTimezone!==cfg.providerTimezone)fail('FLEX_BINDING');
    sourceReadTime(model.provenance.flex.readAt,window,'FLEX_READ_TIME');
    flex=adaptFlexArchive(f.archive,{expectedAccount:cfg.account,expectedQueryId:cfg.configuredQueryId,sourceDate:r.sourceDate,readAt:model.provenance.flex.readAt});
  }else if(!model.fieldState||!['not-called','request-failure'].includes(f?.status))fail('FLEX_SOURCE');
  const snapshots=Object.keys(SNAPSHOT_SCOPES).map(k=>snapshotSource(k,values[k],r));
  for(const snapshot of snapshots)if(snapshot.status==='date-verified')sourceReadTime(snapshot.provenance.readAt,window,'SNAPSHOT_CAPTURE_TIME');
  const savedLive=values['ib.optionalLive'];
  if(!['captured','partial','not-called','failed','timeout'].includes(savedLive?.status))fail('LIVE_STATUS');
  if(['captured','partial'].includes(savedLive.status)){
    if(!Array.isArray(savedLive.sources)||savedLive.sources.length>3||new Set(savedLive.sources.map(s=>s.sourceKey)).size!==savedLive.sources.length)fail('LIVE_SOURCE');
    for(const s of savedLive.sources){
      if(!['ib.accountSummary','ib.positions','ib.orders'].includes(s.sourceKey)||!instant(s.startedAt)||!instant(s.completedAt)
        ||s.startedAt<r.startedAt||s.completedAt>r.completedAt||s.startedAt>s.completedAt||s.rawFingerprint!==fingerprint(s.raw))fail('LIVE_SOURCE');
      sourceReadTime(s.startedAt,window,'LIVE_CAPTURE_TIME');sourceReadTime(s.completedAt,window,'LIVE_CAPTURE_TIME');
      inspectOrdersAccountEvidence(s.raw);
    }
  }
  const sourceOutcomes=[{sourceKey:'ib.flexEod',status:flex?'verified':f.status,rawFingerprint:flex?.rawFingerprint??null},
    ...snapshots.map(s=>({sourceKey:s.sourceKey,status:s.status,rawFingerprint:s.rawFingerprint??null})),
    {sourceKey:'ib.optionalLive',status:savedLive.status,rawFingerprint:['captured','partial'].includes(savedLive.status)?digest(savedLive):null}];
  for(const source of r.sources)if(source.rawFingerprint!==sourceOutcomes.find(s=>s.sourceKey===source.sourceKey)?.rawFingerprint)fail('RAW_FINGERPRINT');
  const rebuilt=buildEodActionModel({dataDate:r.dataDate,sourceDate:r.sourceDate,asOfHkt:window.asOfHkt,flex,snapshots,
    live:['captured','partial'].includes(savedLive.status)?{...savedLive,previousHtml:context.previousHtml}:savedLive,
    reserve:call.amountUsd,evidenceSha256:digest(sourceOutcomes),sourceOutcomes,fieldMode:!!model.fieldState,assumeSharesightSynchronized:model.calculationBasis===SHARESIGHT_BOOK_BASIS,
    bookDetailVersion:Object.hasOwn(model,'observedOrderPlan')?3:Object.hasOwn(model,'bookPlan')?2:1,concentrationInput,dateBasis:model.dateBasis??null,
    callRecord:model.fieldState?call:null,captureStartedAt:model.provenance.capture?.startedAt??null,captureCompletedAt:model.provenance.capture?.completedAt??null});
  rebuilt.sourceManifestSha256=r.sourceManifestSha256;
  rebuilt.evidenceSha256=digest({sourceOutcomes:rebuilt.sourceOutcomes,sourceManifestSha256:r.sourceManifestSha256});
  if(renderNightActionReport(rebuilt)!==renderNightActionReport(model))fail('SOURCE_MODEL_MISMATCH');
}

/** Trusted seams only: readPinnedSource({name,generation,sha256}) returns bytes
 * from an actual authenticated fixed-bucket generation GET; it is not a proof
 * stub. loadContext receives phase/policyCommit/now and must read trusted Git.
 * Historical loader support and trusted Flex config are mandatory when used;
 * unsupported completion/financial proof formats fail closed.
 */
export function createProtectedOwnerVerifier({loadContext,readPinnedSource,now:clock=Date.now}={}){
  if(typeof loadContext!=='function'||typeof readPinnedSource!=='function'||typeof clock!=='function')fail('CAPABILITIES_UNAVAILABLE');
  return async({metadata,html,receipt,now:suppliedNow,phase,signal}={})=>{
    let validatorPoint='entry';
    try{
      signal?.throwIfAborted();validatorPoint='phase-clock';
      const time=clock();
      // The caller's planner timestamp is descriptive only. All admission
      // decisions use the trusted clock closure, including after slow reads.
      if(!Number.isFinite(time)||suppliedNow!==undefined&&!Number.isFinite(suppliedNow)
        ||!['candidate-admission','historical-authenticity'].includes(phase))fail('PHASE_OR_CLOCK');
      validatorPoint='input-copy';const htmlBytes=bytesCopy(html,MAX_HTML),receiptBytes=bytesCopy(receipt,MAX_RECEIPT);
      const m=JSON.parse(JSON.stringify(metadata)),text=decode(htmlBytes),r=parsed(receiptBytes,MAX_RECEIPT),model=admittedModel(text);
      validatorPoint='metadata';metadataBinding(m,r,htmlBytes,receiptBytes,model,time);
      const recoveryId=recoveryRequestId(m.receiptObject);
      if(recoveryId&&r.sources?.some(s=>s.privateObject.slice(0,s.privateObject.lastIndexOf('/'))!==m.artifactObject.slice(0,m.artifactObject.lastIndexOf('/'))))fail('RECOVERY_SOURCE_BINDING');
      if(recoveryId&&phase==='candidate-admission'){const registration=registeredOwnerRecovery();
        if(recoveryId!==registration.requestId||r.dataDate!==registration.dataDate)fail('RECOVERY_REGISTRATION');}
      validateEodReceipt(r,text,m.dataDate,r.sourceDate);
      // Browser book values use the authentic Sharesight valuation date.
      // Other source contracts retain their completed-session requirement.
      if(r.dateBasis!==SHARESIGHT_VALUATION_DATE_BASIS){
        try{validateCompletedEodSession(r.sourceDate,Date.parse(r.startedAt));}catch{fail('COMPLETED_SESSION_REQUIRED');}
      }
      if(phase==='candidate-admission'&&(time>ownerCaptureDeadline(recoveryId,r.startedAt,r.captureCompletedAt)
        ||new Date(time+28800000).toISOString().slice(0,10)!==r.dataDate))fail('CANDIDATE_STALE');
      const contextOptions={phase,policyCommit:phase==='historical-authenticity'?r.association.policyCommit:undefined,now:()=>clock(),...(signal?{signal}:{})};
      validatorPoint='context-first';const context=await loadContext(contextOptions),contextHash=contextBinding(context,r,phase,clock()),call=callBinding(context,model);
      signal?.throwIfAborted();validatorPoint='display';const values=Object.fromEntries(await Promise.all(r.sources.map(async source=>{
        if(!KEYS.includes(source.sourceKey)||!GEN.test(source.generation)||!HASH.test(source.sha256))fail('SOURCE_PIN');
        const prefix='report-check/'+r.startedAt+'-';
        if(!source.privateObject.startsWith(prefix))fail('SOURCE_RUN_PREFIX');
        const pin=Object.freeze({name:source.privateObject,generation:source.generation,sha256:source.sha256});
        const raw=bytesCopy(await readPinnedSource({...pin,...(signal?{signal}:{})}),MAX_SOURCE);
        if(sha(raw)!==source.sha256)fail('SOURCE_BYTES_HASH');
        return [source.sourceKey,parsed(raw,MAX_SOURCE)];
      })));
      if(recoveryId&&['captured','partial'].includes(values['ib.optionalLive']?.status)){
        const live=values['ib.optionalLive'],normal=live.normalMcpEvidence;
        if(normal){
          // The same immutable request and pinned ib.optionalLive object bind
          // normal MCP capture. This is provenance, not an authorization grant.
          if(!exact(live,['status','sources','normalMcpEvidence'])||live.status!=='captured'||live.sources?.length!==1
            ||live.sources[0]?.sourceKey!=='ib.orders'||!exact(normal,['schema','requestId','channel'])
            ||normal.schema!=='xuan.normal-mcp-orders.v1'||normal.requestId!==recoveryId
            ||!['cloud-mcp','mac-mcp'].includes(normal.channel))fail('RECOVERY_SOURCE_BINDING');
        }else if(live.probeEvidence?.object?.name!==`report-check/orders-probe-${recoveryId}/orders.json`)fail('RECOVERY_SOURCE_BINDING');
      }
      const reference=(phase==='historical-authenticity'?registeredHistoricalReferenceCapture:registeredReferenceCapture)(recoveryId,r.startedAt,r.captureCompletedAt);
      if((r.referenceMode??null)!==(reference?.schema??null))fail('REFERENCE_BINDING');
      validateReferenceSources(reference,values);
      let concentrationInput=null;
      if(r.concentration){
        const c=r.concentration,raw=bytesCopy(await readPinnedSource({name:c.privateObject,generation:c.generation,sha256:c.sha256,...(signal?{signal}:{})}),MAX_SOURCE);
        if(sha(raw)!==c.sha256)fail('CONCENTRATION_BYTES_HASH');
        concentrationInput=parsed(raw,MAX_SOURCE);
        if(model.concentration.readWindow.completedAt>r.completedAt)fail('CONCENTRATION_READ_TIME');
        if(model.dateBasis){
          const ib=concentrationInput.sources?.find(s=>s.receipt?.sourceKey==='sharesight.ibGroupedPerformance');
          if(ib?.receipt.route!=='authenticated-browser'||digest(normalizeBrowserSnapshot(JSON.parse(ib.bytes),{portfolioId:936247,sourceDate:r.sourceDate}).raw)!==digest(values['sharesight.ibGroupedPerformance'].raw))fail('CONCENTRATION_IB_BINDING');
        }
      }
      sourceModel(values,r,model,context,call,concentrationInput);
      signal?.throwIfAborted();validatorPoint='context-second';const current=await loadContext(contextOptions),endTime=clock();
      signal?.throwIfAborted();validatorPoint='final-check';if(!Number.isFinite(endTime)||endTime<time)fail('CLOCK_CHANGED');
      if(contextBinding(current,r,phase,endTime)!==contextHash)fail('CONTEXT_CHANGED');
      callBinding(current,model);
      if(phase==='candidate-admission'&&(endTime>ownerCaptureDeadline(recoveryId,r.startedAt,r.captureCompletedAt)
        ||new Date(endTime+28800000).toISOString().slice(0,10)!==r.dataDate))fail('CANDIDATE_STALE');
      return {scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,artifactSha256:m.artifactSha256,receiptSha256:m.receiptSha256,
        sourceIdentitySha256:SOURCE_IDENTITY_SHA256,policyRevision:fingerprint(current.association.policy),financialStatus:m.financialStatus};
    }catch(error){
      const evidence=createOwnerFailureEvidence(error,{validatorPhase:phase,validatorPoint});
      let code;try{if(error&&!nodeTypes.isProxy(error))code=Object.getOwnPropertyDescriptor(error,'safeCode')?.value;}catch{}
      const rejected=typeof code==='string'&&code.startsWith('OWNER_ADMISSION_')?error:Object.assign(Error('OWNER_ADMISSION_REJECTED'),{safeCode:'OWNER_ADMISSION_REJECTED'});
      try{Object.defineProperty(rejected,'failureEvidence',{value:evidence,enumerable:false});}catch{}
      throw rejected;
    }
  };
}
