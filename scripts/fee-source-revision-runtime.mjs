// One explicitly reviewed historical-source recovery. This factory is used only
// after the original producer admission gate; it grants no run, write or publish
// permission. Credentials are supplied by the existing protected Node process.
import crypto from 'node:crypto';
import {types} from 'node:util';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {validateReportPlan,isReviewedDailyPlan} from './fee-report-period.mjs';
import {verifyEconomicSnapshot} from './fee-economic-source.mjs';
import {SharesightIbManagerReader,IB_CASH_RECONCILIATION_SITES,IB_CASH_DATE_ROLES} from './ib-manager-source.mjs';
import {createRevisionGithubRead} from './fee-sync-revision-github.mjs';
import {createIbRevisionArtifacts,ibRevisionArtifactFailureCode,ibRevisionArtifactCashSite,ibRevisionArtifactCashDateRole} from './fee-sync-revision-artifacts.mjs';

const PREFIX='FEE_REPORT_SOURCE_REVISION_',errors=new WeakMap();
const CONTRACTS=Object.freeze({
  'ib-source-revision-20261106-v1':'fee-console.ib-source-revision-plan.v1',
  'ib-source-revision-20261106-sync-v2':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-sync-v3':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v1':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v2':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v3':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v4':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v5':'fee-console.ib-source-revision-plan.v2',
  'ib-source-revision-20261106-diagnostic-v6':'fee-console.ib-source-revision-plan.v2',
}),TARGET='2026-11-06',ANCHOR='2026-11-04',PREVIOUS='2026-11-05';
const DIAGNOSTIC_CONTRACTS=Object.freeze(['ib-source-revision-20261106-diagnostic-v1','ib-source-revision-20261106-diagnostic-v2','ib-source-revision-20261106-diagnostic-v3','ib-source-revision-20261106-diagnostic-v4','ib-source-revision-20261106-diagnostic-v5','ib-source-revision-20261106-diagnostic-v6']);
const SHA=/^[a-f0-9]{64}$/,MAX_BYTES=2*1024*1024;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function failure(code){const e=new Error(PREFIX+code);errors.set(e,code);return e;}
function fail(code){throw Object.freeze(failure(code));}
export const sourceRevisionRuntimeFailureCode=e=>PREFIX+(errors.get(e)||'REFUSED');
// ARTIFACT_SOURCE_CASH_RECONCILIATION keeps the reader's fixed site/date-role
// beside the unchanged code, by error identity only (defaults otherwise).
const cashSites=new Set(IB_CASH_RECONCILIATION_SITES),cashRoles=new Set(IB_CASH_DATE_ROLES),cashSiteByError=new WeakMap(),cashRoleByError=new WeakMap();
export const sourceRevisionRuntimeCashSite=e=>cashSiteByError.get(e)||'UNCLASSIFIED';
export const sourceRevisionRuntimeCashDateRole=e=>cashRoleByError.get(e)||'NONE';
function artifactFailure(error,fallback){
  const code=ibRevisionArtifactFailureCode(error).slice('IB_REVISION_ARTIFACT_'.length);
  if(code!=='SOURCE_CASH_RECONCILIATION')fail(code==='REFUSED'?fallback:'ARTIFACT_'+code);
  const e=failure('ARTIFACT_'+code),site=ibRevisionArtifactCashSite(error),role=ibRevisionArtifactCashDateRole(error);
  cashSiteByError.set(e,cashSites.has(site)?site:'UNCLASSIFIED');
  cashRoleByError.set(e,cashSites.has(site)&&site!=='UNCLASSIFIED'&&cashRoles.has(role)?role:'NONE');
  throw Object.freeze(e);
}
function frozenCopy(value){try{hash(value);const result=structuredClone(value);const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};return freeze(result);}catch{fail('CONFIG');}}
function optionsOf(value){
  const keys=['plan','admission','economicSnapshot','sourceBytes','sourcePayload','healthBytes','githubToken','clientId','clientSecret','keyText','baselineSha256','legacySourcePath','fetchImpl','clock'];
  try{
    if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('CONFIG');
    const ds=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(ds);
    if(keys.some(k=>!Object.hasOwn(ds,k))||actual.some(k=>typeof k!=='string'||![...keys,'diagnosticOnly'].includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('CONFIG');
    if(Object.hasOwn(ds,'diagnosticOnly')&&ds.diagnosticOnly.value!==true)fail('CONFIG');
    const c=Object.fromEntries(actual.map(k=>[k,ds[k].value]));
    if(typeof c.fetchImpl!=='function'||types.isProxy(c.fetchImpl)||typeof c.clock!=='function'||types.isProxy(c.clock)
      ||!verifyEconomicSnapshot(c.economicSnapshot)||!SHA.test(c.baselineSha256||'')
      ||!(c.legacySourcePath===null||typeof c.legacySourcePath==='string')
      ||[c.sourceBytes,c.healthBytes].some(b=>types.isProxy(b)||!Buffer.isBuffer(b)||b.length<1||b.length>MAX_BYTES)
      ||[c.githubToken,c.clientId,c.clientSecret,c.keyText].some(s=>typeof s!=='string'||!s.length||s.length>8192||/[\r\n\0]/.test(s)))fail('CONFIG');
    c.plan=frozenCopy(c.plan);c.sourcePayload=frozenCopy(c.sourcePayload);
    if(!validateReportPlan(c.plan)||!isReviewedDailyPlan(c.plan)||c.plan.kind!=='daily'
      ||c.plan.periodFrom!==TARGET||c.plan.accountingThrough!==TARGET||c.plan.priceThrough!==TARGET
      ||c.plan.markets.join(',')!=='NASDAQ,NYSE'
      ||c.sourcePayload.feeCalculationReceipt?.asOf!==PREVIOUS)fail('SCOPE');
    const normalized=c.keyText.replace(/\+/g,'-').replace(/\//g,'_').replace(/=$/,'');
    if(!/^[A-Za-z0-9_-]{43}$/.test(normalized))fail('CONFIG');
    const key=Buffer.from(normalized,'base64url');if(key.length!==32||key.toString('base64url')!==normalized)fail('CONFIG');
    c.keyText=null;return {...c,key,sourceBytes:Buffer.from(c.sourceBytes),healthBytes:Buffer.from(c.healthBytes)};
  }catch(e){if(errors.has(e))throw e;fail('CONFIG');}
}

export async function createFeeSourceRevisionRuntime(options){
  const c=optionsOf(options);
  let github,artifacts,reader,prepared=null,view=null,closed=false,busy=false,started=false,lastNow=-1,admissionVerified=false;
  const release=()=>{c.key.fill(0);c.sourceBytes.fill(0);c.healthBytes.fill(0);c.githubToken=null;c.clientId=null;c.clientSecret=null;c.sourcePayload=null;
    if(reader){reader.clientId='';reader.clientSecret='';reader=null;}prepared=null;view=null;};
  const close=()=>{if(closed)return;closed=true;
    // Cleanup must not replace the fixed primary refusal. These are only the
    // original factory instances, never caller-authored cleanup callbacks.
    try{artifacts?.close();}catch{}
    try{github?.close();}catch{}
    if(admissionVerified)try{c.admission.close();}catch{}
    release();c.admission=null;
  };
  const live=()=>{if(closed)fail('CLOSED');let t;try{t=c.clock();}catch{close();fail('CLOCK');}
    if(!Number.isSafeInteger(t)||t<0||t<lastNow){close();fail('CLOCK');}lastNow=t;
    if(view&&t>=Date.parse(view.expiresAt)){close();fail('EXPIRED');}return t;};
  try{
    // Dynamic import avoids a module initialization cycle with the sole caller.
    const producer=await import('./fee-report-producer.mjs');
    const isAdmission=c.diagnosticOnly?producer.isHistoricalRevisionDiagnosticAdmission:producer.isHistoricalRevisionAdmission;
    const readAdmission=c.diagnosticOnly?producer.readHistoricalRevisionDiagnosticAdmission:producer.readHistoricalRevisionAdmission;
    if(!isAdmission(c.admission))fail('ADMISSION');
    admissionVerified=true;
    const admitted=readAdmission(c.admission);
    if(c.diagnosticOnly?(!DIAGNOSTIC_CONTRACTS.includes(admitted.contractId)||admitted.purpose!=='read-only-diagnostic')
      :Object.hasOwn(admitted,'purpose'))fail('ADMISSION');
    if(!Object.hasOwn(CONTRACTS,admitted.contractId)||admitted.targetDate!==TARGET)fail('SCOPE');
    const schema=CONTRACTS[admitted.contractId],sync=schema==='fee-console.ib-source-revision-plan.v2';
    if(!SHA.test(sync?admitted.executionSha256:admitted.consumptionSha256)
      ||Object.hasOwn(admitted,sync?'consumptionSha256':'executionSha256')
      ||(sync?admitted.admissionModel!=='sync-cycle-v1':Object.hasOwn(admitted,'admissionModel')))fail('ADMISSION');
    live();
    github=createRevisionGithubRead({token:c.githubToken,fetchImpl:c.fetchImpl,clock:c.clock});
    artifacts=createIbRevisionArtifacts({github,economicSnapshot:c.economicSnapshot,dataKey:c.key,
      legacySourcePath:c.legacySourcePath,baselineSha256:c.baselineSha256,clock:c.clock,admission:c.admission,...(c.diagnosticOnly?{diagnosticOnly:true}:{})});
    // The transport and capability now own only their necessary references.
    c.githubToken=null;
    const check=async()=>{
      live();if(!view)fail('NOT_PREPARED');
      const bindings=await artifacts.checkCurrent();live();
      if(hash(bindings)!==hash(view.bindings))fail('CHANGED');return true;
    };
    const api=Object.freeze({
      async prepare(){
        if(busy||started)fail('REUSE');live();busy=true;started=true;
        let phase='ARTIFACTS';
        try{
          view=await artifacts.readVerifiedArtifacts({targetDate:TARGET,mainSha:admitted.mainSha});live();
          phase='BASE_BINDING';
          if(hash(view.currentPayload)!==hash(c.sourcePayload)||view.bindings.baseDataSha256!==sha(c.sourceBytes)
            ||view.bindings.baseHealthSha256!==sha(c.healthBytes)||view.baselineSha256!==c.baselineSha256
            ||view.currentPayload.feeCalculationReceipt?.asOf!==PREVIOUS
            ||view.anchorPayload.feeCalculationReceipt?.asOf!==ANCHOR)fail('BASE_MISMATCH');
          // These are authenticated source state identifiers, never request claims.
          phase='PLAN';
          const plan=frozenCopy({schema,targetDate:TARGET,anchorDate:ANCHOR,
            baselineSha256:c.baselineSha256,currentSourceStateId:view.currentPayload.ibManagerSourceState?.stateId,
            anchorSourceStateId:view.anchorPayload.ibManagerSourceState?.stateId,currentArtifact:view.artifacts.current,
            anchorArtifact:view.artifacts.anchor,bindings:view.bindings,expiresAt:view.expiresAt});
          phase='READER';reader=new SharesightIbManagerReader({clientId:c.clientId,clientSecret:c.clientSecret,fetchImpl:c.fetchImpl});
          c.clientId=null;c.clientSecret=null;
          phase='CANDIDATE';const candidate=await artifacts.prepareCandidate({plan,reader});live();
          if(candidate.mode!=='extend-cutoff'||candidate.oldThrough!==PREVIOUS||candidate.targetDate!==TARGET)fail('SCOPE');
          phase='RECHECK';await check();
          prepared=Object.freeze({candidate,artifacts,basePayload:view.currentPayload});
          return prepared;
        }catch(e){close();if(errors.has(e))throw e;artifactFailure(e,'PREPARE_'+phase);}
        finally{busy=false;}
      },
      async checkCurrent(){
        if(busy)fail('BUSY');live();busy=true;
        try{if(!prepared)fail('NOT_PREPARED');
          await artifacts.verifyCandidate(prepared.candidate);
          return await check();}
        catch(e){close();if(errors.has(e))throw e;artifactFailure(e,'RECHECK_REFUSED');}
        finally{busy=false;}
      },
      close,
    });
    if(!c.diagnosticOnly)return api;
    // Never expose the prepared candidate, artifact verifier or writer handoff.
    // This mode has no production admission and always destroys private state.
    return Object.freeze({
      async diagnose(){try{await api.prepare();await api.checkCurrent();
        return Object.freeze({schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:TARGET});
      }finally{close();}},close,
    });
  }catch(e){close();if(errors.has(e))throw e;fail('CONFIG');}
}
