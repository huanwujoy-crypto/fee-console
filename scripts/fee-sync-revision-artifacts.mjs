// One authenticated historical pair for the reviewed November 6 extension.
// No default network, credentials, source write, publication or execution grant.
import crypto from 'node:crypto';
import {types} from 'node:util';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {guardLegacySourceFile} from './fee-legacy-source-file.mjs';
import {verifyEconomicSnapshot,readEconomicSnapshotBytes,economicSourceDiagnosticCode,ECONOMIC_SOURCE_DIAGNOSTIC_CODES} from './fee-economic-source.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {validateFeeCalculationReceiptWithEcon} from './fee-receipt-core.mjs';
import {preserveReportMonthLocks} from './fee-report-metadata.mjs';
import {validateIbManagerReportState,validateIbOwnerBaselineState,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {SharesightIbManagerReader,ibSourceCaptureRecheckDiagnostic,IB_CAPTURE_RECHECK_DIAGNOSTIC_CODES,ibSourceCaptureUnstableDiagnostic,IB_CAPTURE_UNSTABLE_DIAGNOSTIC_CODES,ibSourceCaptureRecordsSite,ibSourceCaptureEvidence,ibSourceCaptureSuccessEvidence,IB_CAPTURE_RECORDS_SITES,IB_CASH_RECONCILIATION_SITES,IB_CASH_DATE_ROLES} from './ib-manager-source.mjs';
import {createIbSourceRevisionPreparer,isIbSourceRevisionCandidate,ibSourceRevisionFailureCode,ibSourceRevisionCashSite,ibSourceRevisionCashDateRole} from './ib-manager-source-revision.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {isRevisionGithubRead,revisionGithubFailureCode,IB_REVISION_GITHUB_FAILURE_CODES} from './fee-sync-revision-github.mjs';

export const IB_REVISION_ARTIFACT_SCOPE=Object.freeze({targetDate:'2026-11-06',currentDate:'2026-11-05',anchorDate:'2026-11-04',
  current:Object.freeze({candidateSha:'eff2e28f581ae178f871fc0c5f5f5cb0852f9b32',producerRunId:42140821158}),
  anchor:Object.freeze({candidateSha:'5e19be2032b575b187bd53b8e524189697b9f448',producerRunId:41975903735})});
const instances=new WeakSet(),failures=new WeakMap(),OID=/^[a-f0-9]{40}$/,SHA=/^[a-f0-9]{64}$/;
const OWNER='huanwujoy-crypto',REPO=OWNER+'/fee-console',parseExact=createLegacyPolicy().parseExactJson;
const CONTRACT_MODELS=Object.freeze({'ib-source-revision-20261106-v1':'consumption-v1','ib-source-revision-20261106-sync-v2':'sync-cycle-v1',
  'ib-source-revision-20261106-sync-v4':'sync-cycle-v1',
  'ib-source-revision-20261106-sync-v3':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v1':'sync-cycle-v1',
  'ib-source-revision-20261106-diagnostic-v2':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v3':'sync-cycle-v1',
  'ib-source-revision-20261106-diagnostic-v4':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v5':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v6':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v7':'sync-cycle-v1','ib-source-revision-20261106-diagnostic-v8':'sync-cycle-v1'});
const DIAGNOSTIC_ROLES=Object.freeze(['BASE','CURRENT','ANCHOR']);
const GITHUB_STEPS=Object.freeze(['MAIN','COMMIT','TREE','HISTORY','DATA','HEALTH','RUN','JOBS','LOG']);
const ECONOMIC_STAGES=Object.freeze(['FIRST','RECHECK','BYTES','BINDING']);
const economicReason=error=>economicSourceDiagnosticCode(error).replace(/^SOURCE_/,'');
const PREPARE_PHASES=Object.freeze(['READ','ADMISSION','ECON_BYTES','ECON_VERSION','MONTH_LOCKS','SOURCE_PREPARE','RECHECK']);
const githubDiagnosticReason=code=>code.slice('IB_REVISION_GITHUB_'.length).replace(/^JSON_HTTP_/,'HTTP_')
  .replace(/^HTTP_UNPROCESSABLE$/,'HTTP_INVALID').replace(/^HTTP_UNAUTHORIZED$/,'HTTP_AUTH');
// Every public suffix is made only from finite source literals. No exception
// message, route, response, identifier or financial value becomes a diagnostic.
export const IB_REVISION_ARTIFACT_DIAGNOSTIC_CODES=Object.freeze([
  ...ECONOMIC_STAGES.flatMap(stage=>ECONOMIC_SOURCE_DIAGNOSTIC_CODES.map(code=>'ECON_'+stage+'_'+code.replace(/^SOURCE_/,''))),
  ...IB_CAPTURE_RECHECK_DIAGNOSTIC_CODES.map(code=>'SOURCE_RECHECK_'+code),
  ...IB_CAPTURE_UNSTABLE_DIAGNOSTIC_CODES.filter(code=>code!=='UNCLASSIFIED').map(code=>'SOURCE_CAPTURE_'+code),
  ...IB_CAPTURE_RECORDS_SITES.map(site=>'SOURCE_CAPTURE_RECORDS_'+site),
  ...DIAGNOSTIC_ROLES.flatMap(role=>PREPARE_PHASES.map(phase=>'PHASE_'+role+'_'+phase)),
  ...DIAGNOSTIC_ROLES.flatMap(role=>GITHUB_STEPS.flatMap(step=>IB_REVISION_GITHUB_FAILURE_CODES
    .filter(code=>code!=='IB_REVISION_GITHUB_REFUSED').map(code=>'GITHUB_'+role+'_'+step+'_'+githubDiagnosticReason(code)))),
]);
export const isIbRevisionArtifacts=value=>instances.has(value);
function failure(code){const e=new Error('IB_REVISION_ARTIFACT_'+code);failures.set(e,code);return e;}
function fail(code){throw Object.freeze(failure(code));}
export const ibRevisionArtifactFailureCode=e=>'IB_REVISION_ARTIFACT_'+(failures.get(e)||'REFUSED');
// Reader source evidence carried by error identity only (fixed literals).
const sourceEvidenceByError=new WeakMap();
export const ibRevisionArtifactSourceEvidence=e=>sourceEvidenceByError.get(e)||null;
// After a verified candidate only: the reader's explicit success evidence.
const successEvidenceByApi=new WeakMap();
export const ibRevisionArtifactSuccessEvidence=api=>successEvidenceByApi.get(api)||null;
const failWithEvidence=(code,evidence)=>{const e=failure(code);if(evidence)sourceEvidenceByError.set(e,evidence);throw Object.freeze(e);};
// SOURCE_CASH_RECONCILIATION keeps the reader's fixed site/date-role beside the
// unchanged code, by error identity only. Any other error reports the defaults.
const cashSites=new Set(IB_CASH_RECONCILIATION_SITES),cashRoles=new Set(IB_CASH_DATE_ROLES),cashSiteByError=new WeakMap(),cashRoleByError=new WeakMap();
export const ibRevisionArtifactCashSite=e=>cashSiteByError.get(e)||'UNCLASSIFIED';
export const ibRevisionArtifactCashDateRole=e=>cashRoleByError.get(e)||'NONE';
function failCashSource(cashSite,cashDateRole){
  const e=failure('SOURCE_CASH_RECONCILIATION'),site=cashSites.has(cashSite)?cashSite:'UNCLASSIFIED';
  cashSiteByError.set(e,site);cashRoleByError.set(e,site!=='UNCLASSIFIED'&&cashRoles.has(cashDateRole)?cashDateRole:'NONE');
  throw Object.freeze(e);
}
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function copy(v){try{hash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('INPUT');}}
function shape(v,keys,optional=[]){
  if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('CONFIG');
  const d=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(d);
  if(keys.some(k=>!Object.hasOwn(d,k))||own.some(k=>typeof k!=='string'||![...keys,...optional].includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))fail('CONFIG');
  return Object.fromEntries(own.map(k=>[k,d[k].value]));
}
const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(v)?Date.parse(v):NaN;
function decrypt(bytes,version,key){
  let sealed,plain;
  try{const e=copy(parseExact(bytes));if(Object.keys(e).sort().join(',')!=='data,enc,v'||e.enc!==true||e.v!==version||typeof e.data!=='string')fail('ENVELOPE');
    sealed=Buffer.from(e.data,'base64');if(sealed.length<29||sealed.toString('base64')!==e.data)fail('ENVELOPE');
    const d=crypto.createDecipheriv('aes-256-gcm',key,sealed.subarray(0,12));d.setAuthTag(sealed.subarray(-16));
    plain=Buffer.concat([d.update(sealed.subarray(12,-16)),d.final()]);return copy(parseExact(plain));
  }catch(e){if(failures.has(e))throw e;fail('DECRYPT');}finally{sealed?.fill(0);plain?.fill(0);}
}
export function createIbRevisionArtifacts(options){
  const c=shape(options,['github','economicSnapshot','dataKey','legacySourcePath','baselineSha256','clock','admission'],['diagnosticOnly']);
  if(Object.hasOwn(c,'diagnosticOnly')&&c.diagnosticOnly!==true)fail('CONFIG');
  if(!isRevisionGithubRead(c.github)||!verifyEconomicSnapshot(c.economicSnapshot)||types.isProxy(c.dataKey)||!Buffer.isBuffer(c.dataKey)||c.dataKey.length!==32
    ||!SHA.test(c.baselineSha256||'')||typeof c.clock!=='function'||types.isProxy(c.clock)
    ||c.legacySourcePath!==null&&typeof c.legacySourcePath!=='string')fail('CONFIG');
  c.dataKey=Buffer.from(c.dataKey);
  let closed=false,busy=false,record=null,candidate=null,sourceCapture=null,sourceReader=null,prepared=false,lastNow=-1,role='BASE',phase='READ';
  const at=async(name,operation)=>{const previous=phase;phase=name;const result=await operation();phase=previous;return result;};
  const economicCheck=async(stage,operation)=>{try{return await operation();}catch(error){fail('ECON_'+stage+'_'+economicReason(error));}};
  const live=()=>{if(closed)fail('CLOSED');};
  const now=()=>{const n=c.clock();if(!Number.isSafeInteger(n)||n<0||n<lastNow)fail('CLOCK');lastNow=n;return n;};
  const active=()=>{live();if(record&&now()>=record.expiresAt)fail('EXPIRED');};
  const admissionCurrent=async()=>{
    // Avoid a static report -> artifacts -> producer import cycle. The actual
    // producer's WeakMap admission is required; JSON and callbacks cannot mint it.
    const producer=await import('./fee-report-producer.mjs');
    const isAdmission=c.diagnosticOnly?producer.isHistoricalRevisionDiagnosticAdmission:producer.isHistoricalRevisionAdmission;
    const readAdmission=c.diagnosticOnly?producer.readHistoricalRevisionDiagnosticAdmission:producer.readHistoricalRevisionAdmission;
    active();if(!isAdmission(c.admission))fail('ADMISSION');
    const before=copy(readAdmission(c.admission));
    if(c.diagnosticOnly?(!['ib-source-revision-20261106-diagnostic-v1','ib-source-revision-20261106-diagnostic-v2','ib-source-revision-20261106-diagnostic-v3','ib-source-revision-20261106-diagnostic-v4','ib-source-revision-20261106-diagnostic-v5','ib-source-revision-20261106-diagnostic-v6','ib-source-revision-20261106-diagnostic-v7','ib-source-revision-20261106-diagnostic-v8'].includes(before.contractId)||before.purpose!=='read-only-diagnostic')
      :Object.hasOwn(before,'purpose'))fail('ADMISSION');
    const checked=copy(await at('ADMISSION',()=>c.admission.checkCurrent()));active();
    if(hash(before)!==hash(checked)||!Object.hasOwn(CONTRACT_MODELS,before.contractId)||before.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate
      ||!OID.test(before.mainSha))fail('ADMISSION');
    const sync=CONTRACT_MODELS[before.contractId]==='sync-cycle-v1';
    if(!SHA.test(sync?before.executionSha256:before.consumptionSha256)
      ||Object.hasOwn(before,sync?'consumptionSha256':'executionSha256')
      ||(sync?before.admissionModel!=='sync-cycle-v1':Object.hasOwn(before,'admissionModel')))fail('ADMISSION');
    return before;
  };
  const get=async route=>{
    active();let raw;
    try{raw=await c.github.readJson(route);}catch(error){
      const code=revisionGithubFailureCode(error);
      if(code!=='IB_REVISION_GITHUB_REFUSED'&&IB_REVISION_GITHUB_FAILURE_CODES.includes(code)){
        const step=route==='git/ref/heads/main'?'MAIN':route.startsWith('git/commits/')?'HISTORY'
          :route.startsWith('commits/')?'COMMIT':route.startsWith('git/trees/')?'TREE'
          :route.startsWith('contents/data.json?')?'DATA':route.startsWith('contents/fee-data-health.json?')?'HEALTH'
          :route.endsWith('/jobs?per_page=100')?'JOBS':'RUN';
        fail('GITHUB_'+role+'_'+step+'_'+githubDiagnosticReason(code));
      }
      throw error;
    }
    const x=copy(raw);active();return x;
  };
  const main=async()=>{const x=await get('git/ref/heads/main');if(!OID.test(x.object?.sha||''))fail('MAIN');return x.object.sha;};
  const signed=async sha=>{
    const x=await get('commits/'+sha);
    if(x.sha!==sha||x.commit?.verification?.verified!==true||x.commit.verification.reason!=='valid'
      ||x.author?.login!==OWNER||x.author?.id!==283054367||x.author?.type!=='User'||!OID.test(x.commit?.tree?.sha||'')
      ||!Array.isArray(x.parents)||x.parents.length>2||x.parents.some(p=>!OID.test(p.sha||'')))fail('COMMIT');
    return x;
  };
  const tree=async sha=>{
    const t=await get('git/trees/'+sha);
    if(t.sha!==sha||t.truncated!==false||!Array.isArray(t.tree)||!t.tree.length||t.tree.length>1000
      ||new Set(t.tree.map(x=>x.path)).size!==t.tree.length||t.tree.some(x=>typeof x.path!=='string'||x.path.includes('/')||!OID.test(x.sha||'')||!['blob','tree'].includes(x.type)))fail('TREE');
    return t.tree;
  };
  const entry=(t,name)=>{const e=t.find(x=>x.path===name);if(e?.type!=='blob'||e.mode!=='100644'||!Number.isSafeInteger(e.size)||e.size<1)fail('ARTIFACT');return e;};
  const file=async(name,sha,expected)=>{
    const x=await get('contents/'+name+'?ref='+sha),limit=name==='data.json'?2*1024*1024-1:65536;
    if(x.type!=='file'||x.path!==name||x.encoding!=='base64'||x.sha!==expected.sha||x.size!==expected.size||x.size>limit||typeof x.content!=='string')fail('ARTIFACT');
    const encoded=x.content.replaceAll('\n',''),bytes=Buffer.from(encoded,'base64');
    if(bytes.length!==x.size||bytes.toString('base64')!==encoded||blob(bytes)!==expected.sha){bytes.fill(0);fail('ARTIFACT');}return bytes;
  };
  const history=async head=>{
    let sha=head;const seen=new Set(),found=[];
    for(let count=0;count<128;count++){
      if(seen.has(sha))fail('HISTORY');seen.add(sha);
      if(sha===IB_REVISION_ARTIFACT_SCOPE.current.candidateSha)found.push('current');
      if(sha===IB_REVISION_ARTIFACT_SCOPE.anchor.candidateSha){found.push('anchor');break;}
      const x=await get('git/commits/'+sha);
      if(x.sha!==sha||!Array.isArray(x.parents)||!x.parents.length||x.parents.length>2||x.parents.some(p=>!OID.test(p.sha||'')))fail('HISTORY');
      sha=x.parents[0].sha;
    }
    if(found.join(',')!=='current,anchor')fail('HISTORY');
  };
  const producerProof=async(scope,date,bytes,healthBytes,commit,candidateTree)=>{
    const run=await get('actions/runs/'+scope.producerRunId);
    if(run.id!==scope.producerRunId||run.status!=='completed'||run.conclusion!=='success'||run.run_attempt!==1||!['schedule','workflow_dispatch'].includes(run.event)
      ||run.head_branch!=='main'||run.path!=='.github/workflows/fee-cloud-producer.yml'||run.head_repository?.full_name!==REPO||!OID.test(run.head_sha||''))fail('PRODUCER');
    const jobs=await get('actions/runs/'+run.id+'/jobs?per_page=100');
    if(!Array.isArray(jobs.jobs)||jobs.total_count!==jobs.jobs.length||jobs.jobs.length>100||new Set(jobs.jobs.map(x=>x.id)).size!==jobs.jobs.length)fail('PRODUCER');
    const found=jobs.jobs.filter(j=>j.name==='produce'||j.name==='Produce daily '+date);
    if(found.length!==1)fail('PRODUCER');const job=found[0],health=copy(parseExact(healthBytes));
    if(!Number.isSafeInteger(job.id)||job.id<1||job.run_id!==run.id||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'
      ||!Array.isArray(job.steps)||!Number.isFinite(time(job.started_at))||!Number.isFinite(time(job.completed_at))||time(job.completed_at)<time(job.started_at)
      ||time(health.checkedAt)<time(job.started_at)||time(health.checkedAt)>time(job.completed_at))fail('PRODUCER');
    for(const name of ['Read, calculate and validate the encrypted candidate','Create a signed owner candidate']){
      const steps=job.steps.filter(s=>s.name===name);if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')fail('PRODUCER');
    }
    if(commit.parents.length!==1||commit.parents[0].sha!==run.head_sha||commit.commit.message!=='daily '+date)fail('PRODUCER');
    const source=await signed(run.head_sha),sourceTree=await tree(source.commit.tree.sha),paths=new Set([...sourceTree,...candidateTree].map(x=>x.path));
    const changed=[...paths].filter(p=>{const a=sourceTree.find(x=>x.path===p),b=candidateTree.find(x=>x.path===p);return !a||!b||a.sha!==b.sha||a.type!==b.type||a.mode!==b.mode;});
    if(!changed.includes('fee-data-health.json')||changed.length>2||changed.some(p=>!['data.json','fee-data-health.json'].includes(p)))fail('PRODUCER');
    // The historical source version is authenticated here. It is not asserted
    // to equal today's repaired program or to authorize a new source read.
    let log;try{
      active();log=await c.github.readJobLog(job.id);active();
      const {readProducerLogRecord}=await import('./codex-fee-credentials.mjs');
      const result=readProducerLogRecord(log),step=job.steps.find(x=>x.name==='Create a signed owner candidate'),end=time(step.completed_at);
      const millis=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(step.completed_at||'')?999:0;
      if(result.oid!==scope.candidateSha||!Number.isFinite(time(step.started_at))||!Number.isFinite(end)||end<time(step.started_at)
        ||time(step.started_at)<time(job.started_at)||end>time(job.completed_at)||time(result.at)<time(step.started_at)||time(result.at)>end+millis)fail('PRODUCER');
    }catch(e){if(failures.has(e))throw e;
      const code=revisionGithubFailureCode(e);
      if(code!=='IB_REVISION_GITHUB_REFUSED'&&IB_REVISION_GITHUB_FAILURE_CODES.includes(code))fail('GITHUB_'+role+'_LOG_'+githubDiagnosticReason(code));
      fail('PRODUCER');}finally{log?.fill(0);}
    if(health.dataSha256!==digest(bytes))fail('HEALTH');
  };
  const validatePayload=async(payload,date,economic)=>{
    if(payload.feeCalculationReceipt?.asOf!==date||!validateFeeCalculationReceiptWithEcon(payload.feeCalculationReceipt,payload,economic).ok)fail('FEE_RECEIPT');
    await at('MONTH_LOCKS',()=>preserveReportMonthLocks(payload,payload,economic));
    try{
      const source=await validateIbManagerReportState(payload,c.baselineSha256),owner=await validateIbOwnerBaselineState(payload,c.baselineSha256);
      if(source?.schema!=='fee-console.ib-manager-source.v3'||source.sourceAsOf!==date||owner&&hash(source.ownerBaseline)!==hash(owner))fail('IB_STATE');
      const view={state:'verified',...payload.feeCalculationReceipt};
      const ret=await createIbManagerReturnConsumer().project(payload.ibManagerReturnReceipt,view,payload.ibManagerSourceStatus);
      const dd=await createIbManagerDrawdownConsumer().project(payload.ibManagerDrawdownReceipt,payload.ibManagerReturnReceipt,view,payload.ibManagerSourceStatus);
      if(ret.state!=='verified'||dd.state!=='verified'||ret.asOf!==date||dd.asOf!==date)fail('IB_STATE');
    }catch(e){if(failures.has(e))throw e;fail('IB_STATE');}
  };
  const check=async()=>{
    active();if(!record)fail('NOT_READ');
    const admission=await admissionCurrent();if(hash(admission)!==record.admissionSha256||await main()!==record.mainSha)fail('CHANGED');
    await economicCheck('RECHECK',()=>c.economicSnapshot.checkCurrent());active();
    if((await at('ECON_VERSION',()=>economicCheck('BINDING',()=>c.economicSnapshot.getVersionBinding()))).sha256!==record.bindings.economicRevisionSha256)fail('CHANGED');
    try{record.checkLegacy();}catch{fail('LEGACY_SOURCE');}active();return record.bindings;
  };
  const run=async(operation,initialPhase='READ')=>{live();if(busy)fail('BUSY');busy=true;role='BASE';phase=initialPhase;try{return await operation();}catch(e){
    closed=true;record=null;candidate=null;sourceCapture=null;sourceReader=null;c.dataKey.fill(0);if(failures.has(e))throw e;
    const revisionCode=ibSourceRevisionFailureCode(e);
    if(revisionCode==='IB_REVISION_SOURCE_REFUSED_IB_SOURCE_CASH_RECONCILIATION')failCashSource(ibSourceRevisionCashSite(e),ibSourceRevisionCashDateRole(e));
    if(revisionCode.startsWith('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_'))fail('SOURCE_'+revisionCode.slice('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_'.length));
    if(revisionCode!=='IB_REVISION_REFUSED')fail('REVISION_'+revisionCode.slice('IB_REVISION_'.length));
    fail('PHASE_'+role+'_'+phase);
  }finally{busy=false;}};
  const read=async request=>{
    const r=copy(request);if(Object.keys(r).sort().join(',')!=='mainSha,targetDate'||r.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate||!OID.test(r.mainSha||''))fail('SCOPE');
    if(record){if(r.mainSha!==record.mainSha)fail('CHANGED');await check();return record.view;}
    const started=now(),admission=await admissionCurrent();if(admission.mainSha!==r.mainSha||await main()!==r.mainSha)fail('MAIN');
    // Start the deadline before the first artifact/financial read.
    record={expiresAt:started+300000};active();
    const head=await signed(r.mainSha),mainTree=await tree(head.commit.tree.sha);await history(r.mainSha);
    await economicCheck('FIRST',()=>c.economicSnapshot.checkCurrent());active();let economicBytes;const artifacts={},payloads={};let economic,checkLegacy;
    try{
      economicBytes=await at('ECON_BYTES',()=>economicCheck('BYTES',()=>readEconomicSnapshotBytes(c.economicSnapshot)));economic=decrypt(economicBytes,4,c.dataKey);
      // The existing independent-file guard remains mandatory for legacy v2.
      // An embedded old envelope or a caller-provided digest cannot replace it.
      try{checkLegacy=guardLegacySourceFile(economic,c.dataKey,c.legacySourcePath);}catch{fail('LEGACY_SOURCE');}
      for(const artifactRole of ['current','anchor']){
        role=artifactRole.toUpperCase();
        const scope=IB_REVISION_ARTIFACT_SCOPE[artifactRole],date=artifactRole==='current'?IB_REVISION_ARTIFACT_SCOPE.currentDate:IB_REVISION_ARTIFACT_SCOPE.anchorDate;
        const commit=await signed(scope.candidateSha),t=await tree(commit.commit.tree.sha),dataEntry=entry(t,'data.json'),healthEntry=entry(t,'fee-data-health.json');
        if(artifactRole==='current'&&['data.json','fee-data-health.json'].some(name=>entry(mainTree,name).sha!==entry(t,name).sha))fail('CURRENT_PAIR');
        let data,healthBytes;try{
          data=await file('data.json',scope.candidateSha,dataEntry);healthBytes=await file('fee-data-health.json',scope.candidateSha,healthEntry);
          const health=copy(parseExact(healthBytes));
          if(validateHealth(health,{now:new Date(health.checkedAt)}).length||health.targetDate!==date||health.outcome!=='updated'||health.dataSha256!==digest(data)
            ||!['schwab','webull','benchmark'].every(k=>health.sourceDates[k]===date)||time(health.checkedAt)>started+300000)fail('HEALTH');
          await producerProof(scope,date,data,healthBytes,commit,t);
          const payload=decrypt(data,3,c.dataKey);await validatePayload(payload,date,economic);payloads[artifactRole]=payload;
          artifacts[artifactRole]=freeze({...scope,dataSha256:digest(data),healthSha256:digest(healthBytes)});
        }finally{data?.fill(0);healthBytes?.fill(0);}
      }
      role='BASE';const sync=CONTRACT_MODELS[admission.contractId]==='sync-cycle-v1';
      const bindings=freeze({mainSha:r.mainSha,economicRevisionSha256:(await at('ECON_VERSION',()=>economicCheck('BINDING',()=>c.economicSnapshot.getVersionBinding()))).sha256,
        ...(sync?{admissionModel:'sync-cycle-v1',executionSha256:admission.executionSha256}:{consumptionSha256:admission.consumptionSha256}),
        baseDataSha256:artifacts.current.dataSha256,baseHealthSha256:artifacts.current.healthSha256,currentSourceStateId:payloads.current.ibManagerSourceState.stateId});
      const expiresAt=started+300000,view=freeze({currentPayload:payloads.current,anchorPayload:payloads.anchor,artifacts,bindings,baselineSha256:c.baselineSha256,expiresAt:new Date(expiresAt).toISOString()});
      record={mainSha:r.mainSha,admissionSha256:hash(admission),bindings,view,expiresAt,checkLegacy};await check();return view;
    }finally{economicBytes?.fill(0);}
  };
  const api=Object.freeze({
    readVerifiedArtifacts:r=>run(()=>read(r)),
    checkCurrent:()=>run(check,'RECHECK'),
    prepareCandidate:options=>run(async()=>{
      if(prepared||!record)fail('STATE');const o=shape(options,['plan','reader']),plan=copy(o.plan);prepared=true;
      if(plan.schema!==(record.bindings.admissionModel==='sync-cycle-v1'?'fee-console.ib-source-revision-plan.v2':'fee-console.ib-source-revision-plan.v1')
        ||plan.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate||plan.anchorDate!==IB_REVISION_ARTIFACT_SCOPE.anchorDate||plan.baselineSha256!==c.baselineSha256
        ||plan.currentSourceStateId!==record.view.currentPayload.ibManagerSourceState.stateId||plan.anchorSourceStateId!==record.view.anchorPayload.ibManagerSourceState.stateId
        ||hash(plan.currentArtifact)!==hash(record.view.artifacts.current)||hash(plan.anchorArtifact)!==hash(record.view.artifacts.anchor)
        ||hash(plan.bindings)!==hash(record.bindings)||time(plan.expiresAt)>record.expiresAt||time(plan.expiresAt)<=now())fail('PLAN');
      if(!o.reader||types.isProxy(o.reader)||!SharesightIbManagerReader.prototype.isPrototypeOf(o.reader))fail('READER');
      Reflect.apply(SharesightIbManagerReader.prototype.verifyCapturedRead,o.reader,[null]);sourceReader=o.reader;
      // The source preparer sanitizes foreign callback errors as source errors.
      // Preserve only this adapter's fixed diagnostic when its own surrounding
      // checks fail; a real reader failure keeps the original source classifier.
      let localDiagnostic=null,localEvidence=null;
      const localCheck=async operation=>{try{return await operation();}catch(error){
        localDiagnostic=failures.get(error)||'PHASE_'+role+'_'+phase;throw error;
      }};
      const preparer=createIbSourceRevisionPreparer({clock:now,checkCurrent:()=>localCheck(check),
        verifyAcceptedArtifacts:async x=>localCheck(async()=>{await check();if(hash(x.currentPayload)!==hash(record.view.currentPayload)||hash(x.anchorPayload)!==hash(record.view.anchorPayload)||hash(x.expected)!==hash(record.view.artifacts))fail('ARTIFACT');return record.view.artifacts;}),
        readStable:async args=>{
          await localCheck(async()=>{await check();if(sourceCapture||args.targetDate!==plan.targetDate||hash(args.checkpoint)!==hash(record.view.anchorPayload.ibManagerSourceState.source))fail('SCOPE');});
          // The capture gate's own fixed subdivision replaces the undivided
          // SOURCE_UNSTABLE suffix. Any other reader failure keeps the original
          // source classifier; no source value, route or text is retained.
          try{sourceCapture=await Reflect.apply(SharesightIbManagerReader.prototype.readStableWithEvidence,sourceReader,[args]);}
          catch(error){
            const site=ibSourceCaptureUnstableDiagnostic(error);
            // A classified RECORDS failure names its fixed route/kind location.
            const records=site==='RECORDS'?ibSourceCaptureRecordsSite(error):null;
            if(site!=='UNCLASSIFIED'){localDiagnostic='SOURCE_CAPTURE_'+site+(records?'_'+records:'');localEvidence=ibSourceCaptureEvidence(error);}
            throw error;
          }
          await localCheck(check);return sourceCapture.input;}});
      let result;
      try{result=await at('SOURCE_PREPARE',()=>preparer.prepare({plan,currentPayload:record.view.currentPayload,anchorPayload:record.view.anchorPayload}));}
      catch(error){if(localDiagnostic!==null)failWithEvidence(localDiagnostic,localEvidence);throw error;}
      if(result.mode!=='extend-cutoff'||!isIbSourceRevisionCandidate(result))fail('CANDIDATE');candidate=result;await check();return result;
    }),
    verifyCandidate:value=>run(async()=>{
      if(!candidate||value!==candidate||!isIbSourceRevisionCandidate(value)||!sourceCapture)fail('CANDIDATE');
      await check();try{await Reflect.apply(SharesightIbManagerReader.prototype.checkCapturedReadCurrent,sourceReader,[sourceCapture]);}catch(error){failWithEvidence('SOURCE_RECHECK_'+ibSourceCaptureRecheckDiagnostic(error),ibSourceCaptureEvidence(error));}await check();
      const evidence=ibSourceCaptureSuccessEvidence(sourceCapture);if(evidence)successEvidenceByApi.set(api,evidence);return true;
    }),
    close(){closed=true;record=null;candidate=null;sourceCapture=null;sourceReader=null;c.dataKey.fill(0);},
  });
  // A diagnostic instance never has the artifact brand required by the writer.
  if(!c.diagnosticOnly)instances.add(api);return api;
}
