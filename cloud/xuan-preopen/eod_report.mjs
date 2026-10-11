// EOD runner. The fixed runtime supplies archive/account/date/hash evidence;
// independent financial finality and sync-completion verifiers stay optional.
import crypto from 'node:crypto';
import {adaptFlexArchive,adaptPrivateNoahUiExport,applyFinancialVerification,digest,readVerifiedSnapshot,SNAPSHOT_SCOPES,validDate} from './eod_sources.mjs';
import {currentReserve} from './report.mjs';
import {buildEodActionModel} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {renderNightActionReport,extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {validateAssociationSnapshot,createAssociationReceipt,validateAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
import {planPreopen,hktDate} from './calendar.mjs';
const fail=code=>{throw new Error('EOD_REPORT_'+code);};
async function optionalLive(capture,timeoutMs){
  if(!capture)return {status:'not-called',code:'OPTIONAL_LIVE_NOT_CALLED'};
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)fail('LIVE_BOUND');
  const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>capture({signal:controller.signal})).catch(()=>({status:'failed',code:'OPTIONAL_LIVE_FAILED'})),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'timeout',code:'OPTIONAL_LIVE_TIMEOUT'});},timeoutMs);})]);}
  finally{clearTimeout(timer);controller.abort();}
}
export async function runPrivateEodReport({sourceDate,io,now=Date.now,loadContext,readArchive,verifyArchive,verifyArchiveFinancial=null,expectedAccount,expectedQueryId,
  snapshotReader,verifySnapshotCompletion,captureOptionalLive=null,optionalTimeoutMs=10_000,privateNoahUiExport=null}={}){
  const started=now(),dataDate=hktDate(started),calendar=planPreopen(started);
  const ny=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(started));const part=k=>ny.find(p=>p.type===k)?.value;const nyDate=part('year')+'-'+part('month')+'-'+part('day');
  if(!validDate(sourceDate)||nyDate<sourceDate||nyDate===sourceDate&&Number(part('hour'))<16||calendar.status!=='generate'||calendar.sourceDate!==sourceDate)fail('COMPLETED_SESSION_REQUIRED');
  if(!io?.savePrivate||typeof loadContext!=='function'||typeof readArchive!=='function'||typeof verifyArchive!=='function')fail('INACTIVE_ADAPTER_REQUIRED');
  const context=await loadContext({now});validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
  const runId=digest(crypto.randomUUID()),association=createAssociationReceipt(context.association,{now:now(),edition:'am',previousSourceSha:context.previousSourceSha,runId});
  // Independent reads retain independent outcomes. Optional OAuth failure
  // cannot reject a valid EOD archive or either Sharesight snapshot outcome.
  const [archiveResult,snapshotResults,liveResult]=await Promise.all([
    Promise.resolve().then(()=>readArchive({sourceDate})),
    Promise.all(Object.keys(SNAPSHOT_SCOPES).map(sourceKey=>sourceKey==='sharesight.noahPerformance'&&privateNoahUiExport!==null
      ? adaptPrivateNoahUiExport(privateNoahUiExport,{sourceDate,reportStart:privateNoahUiExport.reportStart,now})
      : readVerifiedSnapshot(sourceKey,{reader:snapshotReader,verifyCompletion:verifySnapshotCompletion,sourceDate,now}))),
    optionalLive(captureOptionalLive,optionalTimeoutMs),
  ]);
  // Establish approved account, immutable bytes and original source cutoff.
  // configuredQueryId binds consumer config; it does not prove producer query.
  const archiveProof=await verifyArchive({archive:archiveResult,expectedAccount,expectedQueryId,sourceDate});
  if(archiveProof?.status!=='archive-verified'||archiveProof.rawSha256!==digest(archiveResult.bytes)||archiveProof.account!==expectedAccount||archiveProof.configuredQueryId!==expectedQueryId||archiveProof.sourceDate!==sourceDate||archiveProof.generation!==archiveResult.metadata?.generation)fail('ARCHIVE_UNVERIFIED');
  let flex=adaptFlexArchive(archiveResult,{expectedAccount,expectedQueryId,sourceDate,readAt:new Date(now()).toISOString()}),financialProof=null;
  if(typeof verifyArchiveFinancial==='function'){
    try{const proof=await verifyArchiveFinancial({archive:archiveResult,parsed:flex,identity:archiveProof});
      flex=applyFinancialVerification(flex,proof,{expectedAccount,expectedQueryId,sourceDate,generation:archiveResult.metadata.generation});financialProof=proof;
    }catch{ /* Financial evidence failure preserves identity-verified EOD facts. */ }
  }
  const live=liveResult?.status==='captured'?{...liveResult,previousHtml:context.previousHtml}:liveResult;
  const sourceOutcomes=[{sourceKey:'ib.flexEod',status:'verified',rawFingerprint:flex.rawFingerprint},...snapshotResults.map(s=>({sourceKey:s.sourceKey,status:s.status,rawFingerprint:s.rawFingerprint??null})),{sourceKey:'ib.optionalLive',status:live?.status==='captured'?'captured':['not-called','failed','timeout'].includes(live?.status)?live.status:'failed',rawFingerprint:live?.status==='captured'?digest(liveResult):null}];
  const completed=now();if(hktDate(completed)!==dataDate)fail('CROSSED_HKT_DATE');
  const hkt=t=>new Date(t+8*3_600_000).toISOString().slice(11,16);
  const model=buildEodActionModel({dataDate,sourceDate,asOfHkt:`${dataDate} ${hkt(started)}–${hkt(completed)} HKT · 数据至 ${sourceDate}`,flex,snapshots:snapshotResults,live,reserve:currentReserve(context.reserveLedger,dataDate),evidenceSha256:digest(sourceOutcomes),sourceOutcomes});
  const current=await loadContext({now});validateAssociationReceipt(association,current.association,{now:now(),edition:'am',previousSourceSha:context.previousSourceSha,runId});
  if(current.reserveHash!==context.reserveHash||current.previousSourceSha!==context.previousSourceSha)fail('BASE_CHANGED');
  const prefix=`report-check/${new Date(started).toISOString()}-${crypto.randomUUID()}/`,sources=[];
  for(const [sourceKey,value] of [['ib.flexEod',{archive:archiveResult,identityProof:archiveProof,financialProof}],...snapshotResults.map(s=>[s.sourceKey,s]),['ib.optionalLive',liveResult??{status:'failed'}]]){
    const object=prefix+sourceKey+'.json',saved=await io.savePrivate(object,value);
    if(saved?.sha256!==digest(value)||!/^\d+$/.test(saved.generation||''))fail('SAVED_SOURCE_BINDING');
    sources.push({sourceKey,privateObject:object,sha256:saved.sha256,generation:saved.generation,rawFingerprint:model.sourceOutcomes.find(s=>s.sourceKey===sourceKey).rawFingerprint});
  }
  const sourceManifestSha256=digest(sourceManifest(sources));
  model.sourceManifestSha256=sourceManifestSha256;
  model.evidenceSha256=digest({sourceOutcomes:model.sourceOutcomes,sourceManifestSha256});
  const html=renderNightActionReport(model);validateNightActionHtml(html,dataDate);
  const artifact={privateObject:prefix+'report.html',...await io.savePrivate(prefix+'report.html',html)};
  const receipt={schemaVersion:1,mode:privateNoahUiExport===null?'private_eod_action':'private_eod_ui_acceptance',status:model.status,dataDate,sourceDate,startedAt:new Date(started).toISOString(),completedAt:new Date(now()).toISOString(),association,sourceCount:sources.length,sources,sourceOutcomes:model.sourceOutcomes,sourceManifestSha256,evidenceSha256:model.evidenceSha256,artifact,publication:'none',scheduler:'none'};
  if(privateNoahUiExport===null)validateEodReceipt(receipt,html,dataDate,sourceDate);
  else validatePrivateEodUiReceipt(receipt,html,dataDate,sourceDate);
  await io.savePrivate(prefix+'receipt.json',receipt);return receipt;
}
export function validateEodReceipt(r,html,dataDate,sourceDate){
  return validateReceipt(r,html,dataDate,sourceDate,false);
}
// Explicit supplied-input acceptance only. No CLI/env selector, production
// delivery marker or API/sync claim; ordinary receipt validation still rejects.
export function validatePrivateEodUiReceipt(r,html,dataDate,sourceDate){
  return validateReceipt(r,html,dataDate,sourceDate,true);
}
function validateReceipt(r,html,dataDate,sourceDate,privateUi){
  if(r?.schemaVersion!==1||r.mode!==(privateUi?'private_eod_ui_acceptance':'private_eod_action')||r.status!=='partial'||r.dataDate!==dataDate||r.sourceDate!==sourceDate||r.publication!=='none'||r.scheduler!=='none'||r.sourceCount!==4||r.sources?.length!==4||new Set(r.sources.map(s=>s.sourceKey)).size!==4||r.sources.some(s=>!['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive'].includes(s.sourceKey)||!/^[a-f0-9]{64}$/.test(s.sha256||'')||!/^\d+$/.test(s.generation||'')))fail('RECEIPT');
  if(digest(sourceManifest(r.sources))!==r.sourceManifestSha256||r.sources.some(s=>s.rawFingerprint!==r.sourceOutcomes?.find(o=>o.sourceKey===s.sourceKey)?.rawFingerprint))fail('SOURCE_MANIFEST_BINDING');
  if(digest(html)!==r.artifact?.sha256||digest({sourceOutcomes:r.sourceOutcomes,sourceManifestSha256:r.sourceManifestSha256})!==r.evidenceSha256)fail('EVIDENCE_HASH');
  const m=extractNightActionModel(html);if(m.schemaVersion!==9||m.status!==r.status||m.sourceDate!==sourceDate||m.dataDate!==dataDate||m.evidenceSha256!==r.evidenceSha256||m.sourceManifestSha256!==r.sourceManifestSha256||JSON.stringify(m.sourceOutcomes)!==JSON.stringify(r.sourceOutcomes))fail('MODEL_BINDING');
  if(privateUi){if(m.sourceOutcomes.find(s=>s.sourceKey==='sharesight.noahPerformance')?.status!=='ui-export-observed')fail('UI_EXPORT_REQUIRED');}
  else if(m.sourceOutcomes.some(s=>s.status==='ui-export-observed'))fail('UI_EXPORT_PRIVATE_ONLY');
  if(m.sourceOutcomes.find(s=>s.sourceKey==='ib.flexEod')?.status!=='verified'||m.sourceOutcomes.find(s=>s.sourceKey==='ib.flexEod')?.rawFingerprint!==m.provenance.flex.archiveSha256)fail('FLEX_BINDING');
  return m;
}

function sourceManifest(sources){
  if(!Array.isArray(sources)||sources.length!==4)fail('SOURCE_MANIFEST');
  const manifest=sources.map(s=>{
    if(!s||Object.keys(s).sort().join('|')!==['sourceKey','privateObject','generation','sha256','rawFingerprint'].sort().join('|')||typeof s.privateObject!=='string'||!/^report-check\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-f0-9-]{36}\/(?:ib\.flexEod|sharesight\.ibGroupedPerformance|sharesight\.noahPerformance|ib\.optionalLive)\.json$/.test(s.privateObject)||!s.privateObject.endsWith('/'+s.sourceKey+'.json')||!/^[a-f0-9]{64}$/.test(s.sha256||'')||!/^\d+$/.test(s.generation||'')||s.rawFingerprint!==null&&!/^[a-f0-9]{64}$/.test(s.rawFingerprint||''))fail('SOURCE_MANIFEST');
    return {sourceKey:s.sourceKey,privateObject:s.privateObject,generation:s.generation,sha256:s.sha256,rawFingerprint:s.rawFingerprint};
  }).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));
  if(new Set(manifest.map(s=>s.privateObject.slice(0,s.privateObject.lastIndexOf('/')))).size!==1)fail('SOURCE_MANIFEST_PREFIX');
  return manifest;
}
