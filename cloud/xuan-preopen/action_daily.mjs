// Inactive integration seam. No CLI, network, credential lookup or scheduler.
// All effectful capabilities must be supplied by a separately approved runtime.
import {digest,normalizeBrowserSnapshot,validateReferenceObservation,SHARESIGHT_BROWSER_SOURCE,SHARESIGHT_REFERENCE_DATE_BASIS,referenceDay} from './eod_sources.mjs';
import {planPreopen} from './calendar.mjs';
import {inspectOrdersAccountEvidence} from './orders_probe.mjs';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {runPrivateEodReport,saveCompletedDailyReport} from './eod_report.mjs';
import {deliverOwnerLatest} from './owner_latest_delivery.mjs';
import {LATEST_TARGET} from './owner_latest.mjs';
import {buildActionConcentrationCandidate} from '../../scripts/xuan-ib-action-concentration.mjs';
import {parseActionEnvelope,MAX_ACTION_ENVELOPE_BYTES} from '../../scripts/xuan-ib-encrypted-action.mjs';

export const ACTION_CIPHERTEXT_PATH='xuan-ib/action.enc.json';
export const ACTION_FIXED_URL='https://huanwujoy-crypto.github.io/fee-console/xuan-ib/';
const accounts=Object.freeze({
  'sharesight.ibGroupedPerformance':936247,
  'sharesight.schwabPerformance':936249,
  'sharesight.webullPerformance':1350094,
});
const NOAH='sharesight.noahPerformance';
const uuid=x=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x??'');
const head=x=>/^[a-f0-9]{40}$/.test(x??'');
const fail=code=>{throw Error('ACTION_DAILY_'+code);};

/** Supplied observations only. Holdings/cash use Sharesight; IB supplies only
 * orders. The previous manual broker sync is a user premise, never re-run here.
 * NOAH is an explicit optional cash reference, not a fourth risk account. */
export function prepareDailyActionInput(input,{now=Date.now()}={}){
  const frozen=structuredClone(input);
  if(!frozen||Object.keys(frozen).some(k=>!['snapshots','ordersCapture'].includes(k)))fail('INPUT_SCOPE');
  const snapshots=frozen.snapshots;
  if(!snapshots||Object.keys(snapshots).some(k=>!Object.hasOwn(accounts,k)&&k!==NOAH)
    ||Object.keys(accounts).some(k=>!Object.hasOwn(snapshots,k)))fail('THREE_ACCOUNTS_REQUIRED');
  if(Buffer.byteLength(JSON.stringify(frozen))>8*1024*1024)fail('INPUT_BOUND');
  const dataDate=referenceDay(new Date(now).toISOString()),sources=[],times=[];
  for(const [key,raw] of Object.entries(snapshots)){
    if(raw?.source!==SHARESIGHT_BROWSER_SOURCE||raw.dateBasis!==SHARESIGHT_REFERENCE_DATE_BASIS)fail('BROWSER_SOURCE_REQUIRED');
    const n=normalizeBrowserSnapshot(raw,{portfolioId:accounts[key]??936238,sourceDate:raw.observation?.valuationDate});
    validateReferenceObservation(n.raw.observation,{reportDate:dataDate,now});
    const o=n.raw.observation;
    times.push(Date.parse(o.captureStartedAt??o.retrievedAt),Date.parse(o.retrievedAt));
    if(key!==NOAH){
      const bytes=JSON.stringify(raw);
      sources.push({bytes,receipt:{sourceKey:key,status:'date-verified',route:'authenticated-browser',sourceDate:o.valuationDate,
        startedAt:o.captureStartedAt??o.retrievedAt,completedAt:o.retrievedAt,bytes:Buffer.byteLength(bytes),sha256:digest(bytes)}});
    }
  }
  const orders=frozen.ordersCapture??null;
  if(orders!==null){
    if(Object.keys(orders).sort().join('|')!=='channel|sources|status'||orders.status!=='captured'||!['cloud-mcp','mac-mcp'].includes(orders.channel)||orders.sources?.length!==1)fail('ORDERS_SCOPE');
    const s=orders.sources[0];
    if(!['accountEvidence|completedAt|raw|rawFingerprint|sourceKey|startedAt','accountEvidence|completedAt|raw|rawFingerprint|sourceKey|startedAt|transportFingerprint|wrapper'].includes(Object.keys(s??{}).sort().join('|')))fail('ORDERS_SCOPE');
    if(s.sourceKey!=='ib.orders'||!s.raw||s.rawFingerprint!==fingerprint(s.raw)
      ||!Number.isFinite(Date.parse(s.startedAt))||!Number.isFinite(Date.parse(s.completedAt))
      ||s.startedAt>s.completedAt||Date.parse(s.completedAt)>now
      ||referenceDay(s.startedAt)!==dataDate||referenceDay(s.completedAt)!==dataDate)fail('ORDERS_SCOPE');
    if(Object.hasOwn(s,'wrapper')&&(!['native-object','json-string'].includes(s.wrapper)||!/^[a-f0-9]{64}$/.test(s.transportFingerprint??'')||s.wrapper==='native-object'&&s.transportFingerprint!==s.rawFingerprint))fail('ORDERS_SCOPE');
    const evidence=inspectOrdersAccountEvidence(s.raw),e=s.accountEvidence;
    if(!e||Object.keys(e).sort().join('|')!=='associationBasis|nativeIdentityEvidence|responseAccountEvidence'||e.associationBasis!=='owner-attested'
      ||!['matched','not-provided'].includes(e.responseAccountEvidence)||e.nativeIdentityEvidence!==(e.responseAccountEvidence==='matched'?'response-account-id':'not-provided')
      ||evidence.responseAccountEvidence==='matched'&&e.responseAccountEvidence!=='matched')fail('ORDERS_SCOPE');
    times.push(Date.parse(s.startedAt),Date.parse(s.completedAt));
    // The existing model/admission independently validates account evidence,
    // remaining quantities, coverage and the 30-minute orders clock.
  }
  const sourceDate=snapshots['sharesight.ibGroupedPerformance'].observation.valuationDate;
  const concentrationInput={sources,cutoff:sourceDate,referenceReportDate:dataDate};
  buildActionConcentrationCandidate(concentrationInput); // Reject omissions before any write.
  return {dataDate,sourceDate,snapshots,ordersCapture:orders,concentrationInput,inputSha256:digest(frozen),
    startedAt:Math.min(...times),completedAt:Math.max(...times),omitNoahReference:!Object.hasOwn(snapshots,NOAH)};
}

/** Runtime boundary, not an authorization service. admitRun must verify the
 * real approved head/scope; claimDaily/checkpoint must be durable and create-only.
 * The runtime must authorize the existing audience/CAS in prepareCommit.
 * encryptFixed must run the existing packagePublishedAction in its explicitly
 * approved key environment. There is intentionally no default for any of these.
 * A successful run prepares ciphertext for exact-head review, never merges it. */
export function createDailyActionPipeline({now=Date.now,loadContext,admitRun,claimDaily,checkpoint,io,prepareCommit,encryptFixed}={}){
  const required=[loadContext,admitRun,claimDaily,checkpoint,prepareCommit,encryptFixed,
    io?.savePrivateCreateOnly,io?.readDailyBundle,io?.readPinnedSource,io?.readLatest,io?.replaceLatest,io?.readLatestGeneration];
  if(required.some(f=>typeof f!=='function'))fail('APPROVED_RUNTIME_REQUIRED');
  let used=false;
  return Object.freeze({run:async({runId,approvedHead,input}={})=>{
    if(used)fail('ATTEMPT_ALREADY_USED');
    if(!uuid(runId)||!head(approvedHead))fail('RUN_IDENTITY');
    const p=prepareDailyActionInput(input,{now:now()}),plan=planPreopen(now());
    if(plan.status!=='generate'||plan.dataDate!==p.dataDate)fail('NOT_REPORT_DAY');
    const scope={key:'action-day/'+p.dataDate,runId,head:approvedHead,dataDate:p.dataDate,inputSha256:p.inputSha256};
    used=true; // Lock before the first await, including concurrent calls.
    let admission;try{admission=await admitRun(structuredClone(scope));}catch{fail('RUN_ADMISSION_FAILED');}
    const expected={status:'approved',...scope};
    if(!admission||Object.keys(admission).sort().join('|')!==Object.keys(expected).sort().join('|')
      ||Object.entries(expected).some(([k,v])=>admission[k]!==v))fail('RUN_NOT_APPROVED');
    let claim;try{claim=await claimDaily(structuredClone(scope));}catch{fail('DAILY_CLAIM_OUTCOME_UNKNOWN');}
    if(claim?.status!=='created'||claim.key!==scope.key||claim.runId!==runId)fail('DAILY_CLAIM_NOT_ACQUIRED');
    let stage='evidence',count=0,totalBytes=0;
    const prefix=`report-check/${new Date(p.startedAt).toISOString()}-${runId}/`;
    const names=new Set(['ib.flexEod.json','sharesight.ibGroupedPerformance.json','sharesight.noahPerformance.json','ib.optionalLive.json','report.html','concentration.sources.json','receipt.json'].map(n=>prefix+n));
    names.add(`delivery/${p.dataDate}/report.html`);names.add(`delivery/${p.dataDate}/receipt.json`);
    const attempted=new Set();
    const savePrivate=async(name,value)=>{
      const text=typeof value==='string'?value:JSON.stringify(value),bytes=Buffer.byteLength(text);
      if(!names.has(name)||attempted.has(name)||count>=9||totalBytes+bytes>32*1024*1024)fail('EVIDENCE_BOUND');
      attempted.add(name);count++;totalBytes+=bytes;
      await checkpoint({...scope,stage:'evidence-attempt',object:name,sha256:digest(text),bytes});
      const pin=await io.savePrivateCreateOnly(name,text);
      if(pin?.sha256!==digest(text)||!/^\d+$/.test(pin.generation??''))fail('EVIDENCE_PIN');
      return pin;
    };
    try{
      const receipt=await runPrivateEodReport({sourceDate:p.sourceDate,sourceRunId:runId,io:{savePrivate},now,loadContext,
        readArchive:null,fieldMode:true,assumeSharesightSynchronized:true,bookDetailVersion:3,dateBasis:SHARESIGHT_REFERENCE_DATE_BASIS,
        initialStartedAt:p.startedAt,initialCompletedAt:p.completedAt,omitNoahReference:p.omitNoahReference,
        concentrationInput:p.concentrationInput,snapshotReader:async({sourceKey})=>({raw:p.snapshots[sourceKey]}),
        captureOptionalLive:p.ordersCapture===null?null:async()=>p.ordersCapture});
      const generated=await io.readPinnedSource({name:receipt.artifact.privateObject,generation:receipt.artifact.generation,sha256:receipt.artifact.sha256});
      if(!(generated instanceof Uint8Array)||digest(Buffer.from(generated))!==receipt.artifact.sha256)fail('REPORT_PIN');
      await saveCompletedDailyReport({io:{savePrivate},plan,receipt,html:new TextDecoder('utf-8',{fatal:true}).decode(generated)});
      stage='private-cas';await checkpoint({...scope,stage:'private-cas-attempt'});
      let pinnedDisplay=null;
      const publicationIo={...io,readLatestGeneration:async request=>{const bytes=await io.readLatestGeneration(request);if(bytes instanceof Uint8Array)pinnedDisplay=new Uint8Array(bytes);return bytes;}};
      const finalCommit=async options=>{await prepareCommit(options);
        if(receipt.ordersFreshUntil&&now()>Date.parse(receipt.ordersFreshUntil))fail('ORDERS_EXPIRED_BEFORE_CAS');};
      const published=await deliverOwnerLatest({now,loadContext,prepareCommit:finalCommit,storeFactory:()=>publicationIo,
        request:()=>fail('NO_DEFAULT_TRANSPORT'),expectedArtifactSha256:receipt.artifact.sha256});
      if(published.status!=='published-verified')return {status:'stopped',stage,privateResult:published,evidenceWrites:count,retryAllowed:false};
      // Reuse the independent fixed-generation GET verified by the publisher.
      // Never fetch an unpinned latest or infer bytes from the upload ACK.
      stage='fixed-readback';
      const fixed=pinnedDisplay;
      if(!(fixed instanceof Uint8Array)||digest(Buffer.from(fixed))!==published.sha256)fail('FIXED_READBACK');
      const atUtc=new Date(now()).toISOString();
      const proof={status:'PRIVATE_PUBLICATION_FIXED_VERSION_VERIFIED',reportDateHkt:p.dataDate,completedAtUtc:atUtc,target:LATEST_TARGET,
        fixedReadback:{...published,storageStatus:'verified',atUtc}};
      stage='encryption';await checkpoint({...scope,stage:'encryption-attempt',generation:published.generation,sha256:published.sha256});
      const ciphertext=await encryptFixed({htmlBytes:new Uint8Array(fixed),receipt:structuredClone(proof)});
      parseActionEnvelope(ciphertext);
      const candidate={path:ACTION_CIPHERTEXT_PATH,text:ciphertext,sha256:digest(ciphertext),bytes:Buffer.byteLength(ciphertext)};
      await checkpoint({...scope,stage:'ciphertext-prepared',ciphertextSha256:candidate.sha256});
      return {status:'ciphertext-review-required',privateResult:published,evidenceWrites:count,candidate,
        publicPublished:false,reportDate:p.dataDate,approvedCodeHead:approvedHead,retryAllowed:false};
    }catch{
      // Do not log raw provider errors: these may contain private bytes/secrets.
      // Durable pre-attempt records survive a timeout or process interruption.
      return {status:'stopped',stage,evidenceWrites:count,retryAllowed:false};
    }
  }});
}

/** Call only after the normal exact-head ciphertext PR/Pages flow. This does
 * not deploy, poll, decrypt, or infer success from a commit/test/old summary. */
export function verifyDailyActionDelivery({candidate,approvedCiphertextHead,deployment,publicBytes}={}){
  if(!head(approvedCiphertextHead)||deployment?.status!=='success'||deployment.commit!==approvedCiphertextHead
    ||deployment.url!==ACTION_FIXED_URL||candidate?.path!==ACTION_CIPHERTEXT_PATH
    ||!(publicBytes instanceof Uint8Array)||publicBytes.length>MAX_ACTION_ENVELOPE_BYTES
    ||candidate.bytes!==publicBytes.length||digest(Buffer.from(publicBytes))!==candidate.sha256)fail('PUBLIC_READBACK');
  parseActionEnvelope(new TextDecoder('utf-8',{fatal:true}).decode(publicBytes));
  return {status:'public-ciphertext-verified',head:approvedCiphertextHead,sha256:candidate.sha256,url:ACTION_FIXED_URL,unlockStatus:'not-tested'};
}
