// One authenticated historical pair for the reviewed November 6 extension.
// No default network, credentials, source write, publication or execution grant.
import crypto from 'node:crypto';
import {types} from 'node:util';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {guardLegacySourceFile} from './fee-legacy-source-file.mjs';
import {verifyEconomicSnapshot,readEconomicSnapshotBytes} from './fee-economic-source.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {validateFeeCalculationReceiptWithEcon} from './fee-receipt-core.mjs';
import {preserveReportMonthLocks} from './fee-report-metadata.mjs';
import {validateIbManagerReportState,validateIbOwnerBaselineState,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {SharesightIbManagerReader} from './ib-manager-source.mjs';
import {createIbSourceRevisionPreparer,isIbSourceRevisionCandidate,ibSourceRevisionFailureCode} from './ib-manager-source-revision.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {isRevisionGithubRead} from './fee-sync-revision-github.mjs';

export const IB_REVISION_ARTIFACT_SCOPE=Object.freeze({targetDate:'2026-11-06',currentDate:'2026-11-05',anchorDate:'2026-11-04',
  current:Object.freeze({candidateSha:'eff2e28f581ae178f871fc0c5f5f5cb0852f9b32',producerRunId:42140821158}),
  anchor:Object.freeze({candidateSha:'5e19be2032b575b187bd53b8e524189697b9f448',producerRunId:41975903735})});
const instances=new WeakSet(),failures=new WeakMap(),OID=/^[a-f0-9]{40}$/,SHA=/^[a-f0-9]{64}$/;
const OWNER='huanwujoy-crypto',REPO=OWNER+'/fee-console',parseExact=createLegacyPolicy().parseExactJson;
export const isIbRevisionArtifacts=value=>instances.has(value);
function fail(code){const e=new Error('IB_REVISION_ARTIFACT_'+code);failures.set(e,code);throw Object.freeze(e);}
export const ibRevisionArtifactFailureCode=e=>'IB_REVISION_ARTIFACT_'+(failures.get(e)||'REFUSED');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function copy(v){try{hash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('INPUT');}}
function shape(v,keys){
  if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('CONFIG');
  const d=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(d);
  if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))fail('CONFIG');
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
  const c=shape(options,['github','economicSnapshot','dataKey','legacySourcePath','baselineSha256','clock','admission']);
  if(!isRevisionGithubRead(c.github)||!verifyEconomicSnapshot(c.economicSnapshot)||types.isProxy(c.dataKey)||!Buffer.isBuffer(c.dataKey)||c.dataKey.length!==32
    ||!SHA.test(c.baselineSha256||'')||typeof c.clock!=='function'||types.isProxy(c.clock)
    ||c.legacySourcePath!==null&&typeof c.legacySourcePath!=='string')fail('CONFIG');
  c.dataKey=Buffer.from(c.dataKey);
  let closed=false,busy=false,record=null,candidate=null,sourceCapture=null,sourceReader=null,prepared=false,lastNow=-1;
  const live=()=>{if(closed)fail('CLOSED');};
  const now=()=>{const n=c.clock();if(!Number.isSafeInteger(n)||n<0||n<lastNow)fail('CLOCK');lastNow=n;return n;};
  const active=()=>{live();if(record&&now()>=record.expiresAt)fail('EXPIRED');};
  const admissionCurrent=async()=>{
    // Avoid a static report -> artifacts -> producer import cycle. The actual
    // producer's WeakMap admission is required; JSON and callbacks cannot mint it.
    const {isHistoricalRevisionAdmission,readHistoricalRevisionAdmission}=await import('./fee-report-producer.mjs');
    active();if(!isHistoricalRevisionAdmission(c.admission))fail('ADMISSION');
    const before=copy(readHistoricalRevisionAdmission(c.admission));
    const checked=copy(await c.admission.checkCurrent());active();
    if(hash(before)!==hash(checked)||before.contractId!=='ib-source-revision-20261106-v1'||before.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate
      ||!OID.test(before.mainSha)||!SHA.test(before.consumptionSha256))fail('ADMISSION');
    return before;
  };
  const get=async route=>{active();const x=copy(await c.github.readJson(route));active();return x;};
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
    }catch(e){if(failures.has(e))throw e;fail('PRODUCER');}finally{log?.fill(0);}
    if(health.dataSha256!==digest(bytes))fail('HEALTH');
  };
  const validatePayload=async(payload,date,economic)=>{
    if(payload.feeCalculationReceipt?.asOf!==date||!validateFeeCalculationReceiptWithEcon(payload.feeCalculationReceipt,payload,economic).ok)fail('FEE_RECEIPT');
    preserveReportMonthLocks(payload,payload,economic);
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
    const admission=await admissionCurrent();if(admission.mainSha!==record.mainSha||admission.consumptionSha256!==record.bindings.consumptionSha256||await main()!==record.mainSha)fail('CHANGED');
    try{await c.economicSnapshot.checkCurrent();}catch{fail('ECONOMIC_SOURCE');}active();
    if(c.economicSnapshot.getVersionBinding().sha256!==record.bindings.economicRevisionSha256)fail('CHANGED');
    try{record.checkLegacy();}catch{fail('LEGACY_SOURCE');}active();return record.bindings;
  };
  const run=async operation=>{live();if(busy)fail('BUSY');busy=true;try{return await operation();}catch(e){
    closed=true;record=null;candidate=null;sourceCapture=null;sourceReader=null;c.dataKey.fill(0);if(failures.has(e))throw e;
    const revisionCode=ibSourceRevisionFailureCode(e);
    if(revisionCode.startsWith('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_'))fail('SOURCE_'+revisionCode.slice('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_'.length));
    if(revisionCode!=='IB_REVISION_REFUSED')fail('REVISION_'+revisionCode.slice('IB_REVISION_'.length));
    fail('REFUSED');
  }finally{busy=false;}};
  const read=async request=>{
    const r=copy(request);if(Object.keys(r).sort().join(',')!=='mainSha,targetDate'||r.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate||!OID.test(r.mainSha||''))fail('SCOPE');
    if(record){if(r.mainSha!==record.mainSha)fail('CHANGED');await check();return record.view;}
    const started=now(),admission=await admissionCurrent();if(admission.mainSha!==r.mainSha||await main()!==r.mainSha)fail('MAIN');
    // Start the deadline before the first artifact/financial read.
    record={expiresAt:started+300000};active();
    const head=await signed(r.mainSha),mainTree=await tree(head.commit.tree.sha);await history(r.mainSha);
    try{await c.economicSnapshot.checkCurrent();}catch{fail('ECONOMIC_SOURCE');}active();let economicBytes;const artifacts={},payloads={};let economic,checkLegacy;
    try{
      economicBytes=readEconomicSnapshotBytes(c.economicSnapshot);economic=decrypt(economicBytes,4,c.dataKey);
      // The existing independent-file guard remains mandatory for legacy v2.
      // An embedded old envelope or a caller-provided digest cannot replace it.
      try{checkLegacy=guardLegacySourceFile(economic,c.dataKey,c.legacySourcePath);}catch{fail('LEGACY_SOURCE');}
      for(const role of ['current','anchor']){
        const scope=IB_REVISION_ARTIFACT_SCOPE[role],date=role==='current'?IB_REVISION_ARTIFACT_SCOPE.currentDate:IB_REVISION_ARTIFACT_SCOPE.anchorDate;
        const commit=await signed(scope.candidateSha),t=await tree(commit.commit.tree.sha),dataEntry=entry(t,'data.json'),healthEntry=entry(t,'fee-data-health.json');
        if(role==='current'&&['data.json','fee-data-health.json'].some(name=>entry(mainTree,name).sha!==entry(t,name).sha))fail('CURRENT_PAIR');
        let data,healthBytes;try{
          data=await file('data.json',scope.candidateSha,dataEntry);healthBytes=await file('fee-data-health.json',scope.candidateSha,healthEntry);
          const health=copy(parseExact(healthBytes));
          if(validateHealth(health,{now:new Date(health.checkedAt)}).length||health.targetDate!==date||health.outcome!=='updated'||health.dataSha256!==digest(data)
            ||!['schwab','webull','benchmark'].every(k=>health.sourceDates[k]===date)||time(health.checkedAt)>started+300000)fail('HEALTH');
          await producerProof(scope,date,data,healthBytes,commit,t);
          const payload=decrypt(data,3,c.dataKey);await validatePayload(payload,date,economic);payloads[role]=payload;
          artifacts[role]=freeze({...scope,dataSha256:digest(data),healthSha256:digest(healthBytes)});
        }finally{data?.fill(0);healthBytes?.fill(0);}
      }
      const bindings=freeze({mainSha:r.mainSha,economicRevisionSha256:c.economicSnapshot.getVersionBinding().sha256,consumptionSha256:admission.consumptionSha256,
        baseDataSha256:artifacts.current.dataSha256,baseHealthSha256:artifacts.current.healthSha256,currentSourceStateId:payloads.current.ibManagerSourceState.stateId});
      const expiresAt=started+300000,view=freeze({currentPayload:payloads.current,anchorPayload:payloads.anchor,artifacts,bindings,baselineSha256:c.baselineSha256,expiresAt:new Date(expiresAt).toISOString()});
      record={mainSha:r.mainSha,bindings,view,expiresAt,checkLegacy};await check();return view;
    }finally{economicBytes?.fill(0);}
  };
  const api=Object.freeze({
    readVerifiedArtifacts:r=>run(()=>read(r)),
    checkCurrent:()=>run(check),
    prepareCandidate:options=>run(async()=>{
      if(prepared||!record)fail('STATE');const o=shape(options,['plan','reader']),plan=copy(o.plan);prepared=true;
      if(plan.targetDate!==IB_REVISION_ARTIFACT_SCOPE.targetDate||plan.anchorDate!==IB_REVISION_ARTIFACT_SCOPE.anchorDate||plan.baselineSha256!==c.baselineSha256
        ||plan.currentSourceStateId!==record.view.currentPayload.ibManagerSourceState.stateId||plan.anchorSourceStateId!==record.view.anchorPayload.ibManagerSourceState.stateId
        ||hash(plan.currentArtifact)!==hash(record.view.artifacts.current)||hash(plan.anchorArtifact)!==hash(record.view.artifacts.anchor)
        ||hash(plan.bindings)!==hash(record.bindings)||time(plan.expiresAt)>record.expiresAt||time(plan.expiresAt)<=now())fail('PLAN');
      if(!o.reader||types.isProxy(o.reader)||!SharesightIbManagerReader.prototype.isPrototypeOf(o.reader))fail('READER');
      Reflect.apply(SharesightIbManagerReader.prototype.verifyCapturedRead,o.reader,[null]);sourceReader=o.reader;
      const preparer=createIbSourceRevisionPreparer({clock:now,checkCurrent:check,
        verifyAcceptedArtifacts:async x=>{await check();if(hash(x.currentPayload)!==hash(record.view.currentPayload)||hash(x.anchorPayload)!==hash(record.view.anchorPayload)||hash(x.expected)!==hash(record.view.artifacts))fail('ARTIFACT');return record.view.artifacts;},
        readStable:async args=>{await check();if(sourceCapture||args.targetDate!==plan.targetDate||hash(args.checkpoint)!==hash(record.view.anchorPayload.ibManagerSourceState.source))fail('SCOPE');
          sourceCapture=await Reflect.apply(SharesightIbManagerReader.prototype.readStableWithEvidence,sourceReader,[args]);await check();return sourceCapture.input;}});
      const result=await preparer.prepare({plan,currentPayload:record.view.currentPayload,anchorPayload:record.view.anchorPayload});
      if(result.mode!=='extend-cutoff'||!isIbSourceRevisionCandidate(result))fail('CANDIDATE');candidate=result;await check();return result;
    }),
    verifyCandidate:value=>run(async()=>{
      if(!candidate||value!==candidate||!isIbSourceRevisionCandidate(value)||!sourceCapture)fail('CANDIDATE');
      await check();try{await Reflect.apply(SharesightIbManagerReader.prototype.checkCapturedReadCurrent,sourceReader,[sourceCapture]);}catch{fail('SOURCE_CHANGED');}await check();return true;
    }),
    close(){closed=true;record=null;candidate=null;sourceCapture=null;sourceReader=null;c.dataKey.fill(0);},
  });instances.add(api);return api;
}
