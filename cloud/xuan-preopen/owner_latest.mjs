import {ownerCaptureDeadline,registeredReferenceReplacement} from './owner_source_recovery.mjs';
import {recoveryRequestId} from './owner_bundle_contract.mjs';
// Fixed-target private latest planner. All I/O and authorization capabilities
// are injected by the trusted controller; no network or credential defaults.
const SHARESIGHT_VALUATION_DATE_BASIS='sharesight-valuation-date.v1';
import {types as nodeTypes} from 'node:util';
import {safeOwnerFailureEvidence} from './cloud_io.mjs';
import {ownerBundlePathsMatch} from './owner_bundle_contract.mjs';
export const OWNER_SCOPE='ib-hk-classified-stocks__cash-ib-hk-noah-hk__orders-ib.v1';
export const LATEST_TARGET=Object.freeze({bucket:'family-portfolio-gateway-xuan-preopen-private',object:'delivery/owner-latest.html'});
export const LATEST_HEADERS=Object.freeze({contentType:'text/html; charset=utf-8',contentDisposition:'inline',cacheControl:'private, no-store, max-age=0'});
// Only the wire representation at the already fixed authenticated GCS JSON
// media endpoint. Stored object metadata must still equal LATEST_HEADERS.
// A matching API response is byte-delivery proof, not browser-display proof.
export function ownerJsonMediaHeadersMatch(value){
  try{
    if(!value||Object.getPrototypeOf(value)!==Object.prototype
      ||Reflect.ownKeys(value).sort().join('|')!=='cacheControl|contentDisposition|contentType'
      ||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value'))
      ||value.contentType!==LATEST_HEADERS.contentType)return false;
    return value.contentDisposition===LATEST_HEADERS.contentDisposition&&value.cacheControl===LATEST_HEADERS.cacheControl
      ||value.contentDisposition==='attachment'&&value.cacheControl==='no-cache, no-store, max-age=0, must-revalidate';
  }catch{return false;}
}
export const MAX_BYTES=2*1024*1024,MAX_RECEIPT_BYTES=128*1024,DEADLINE_MS=10000,PREPARATION_DEADLINE_MS=60000;
export const ACCEPTED_PREVIEW_SCHEMA='xuan.owner-accepted-preview.v1';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const gen=x=>typeof x==='string'&&/^[1-9][0-9]{0,29}$/.test(x);
const obj=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const fail=code=>{throw Object.assign(Error(code),{safeCode:code});};
const stamp=x=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x)fail('INVALID_TIME');return Date.parse(x);};
const date=x=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\d$/.test(x)||new Date(x+'T00:00:00.000Z').toISOString().slice(0,10)!==x)fail('INVALID_DATE');};
const exact=(x,keys)=>{if(!obj(x)||Object.keys(x).sort().join('|')!==keys.split(' ').sort().join('|'))fail('INVALID_SHAPE');};
export async function sha256(bytes){
  if(!(bytes instanceof Uint8Array))fail('INVALID_BYTES');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function deriveStaticDisplay(original,{preparePrivateReport,Parser=globalThis.DOMParser}={}){
  if(typeof preparePrivateReport!=='function')fail('STATIC_RENDERER_UNAVAILABLE');
  return new TextEncoder().encode(preparePrivateReport(original,{Parser}).srcdoc);
}
function metadata(m,now,ownerBinding){
  const browserDates=Object.hasOwn(m??{},'dateBasis');
  exact(m,'schema scope ownerBinding sourceIdentitySha256 dataDate sourceDate captureStartedAt captureEndedAt completedAt artifactObject artifactGeneration artifactSha256 receiptObject receiptGeneration receiptSha256 financialStatus unknownFields'+(browserDates?' dateBasis':''));
  if(browserDates&&m.dateBasis!==SHARESIGHT_VALUATION_DATE_BASIS)fail('DATE_BASIS');
  if(m.schema!=='xuan.owner-latest.v1'||m.scope!==OWNER_SCOPE||!hex(ownerBinding)||m.ownerBinding!==ownerBinding||!hex(m.sourceIdentitySha256))fail('SCOPE_MISMATCH');
  date(m.sourceDate);date(m.dataDate);
  const start=stamp(m.captureStartedAt),end=stamp(m.captureEndedAt),completed=stamp(m.completedAt);
  if(start>end||end>completed||completed>now||m.dataDate<m.sourceDate||Date.parse(m.sourceDate+(browserDates?'T00:00:00.000+08:00':'T00:00:00.000Z'))>start||Date.parse(m.dataDate+'T00:00:00.000+08:00')>completed)fail('TIME_ORDER');
  if(!ownerBundlePathsMatch(m)||!gen(m.artifactGeneration)||!gen(m.receiptGeneration)||!hex(m.artifactSha256)||!hex(m.receiptSha256))fail('IMMUTABLE_BINDING');
  if(!['complete','partial'].includes(m.financialStatus)||!Array.isArray(m.unknownFields)||m.unknownFields.length>32||new Set(m.unknownFields).size!==m.unknownFields.length||m.unknownFields.some(x=>!['orders','holdings','cash','allocation','prices','sourceIdentity','freshness'].includes(x))||(m.financialStatus==='complete'&&m.unknownFields.length)||(m.financialStatus==='partial'&&!m.unknownFields.length))fail('FINANCIAL_STATE');
  // These structural checks are NOT financial, identity, authorization or
  // freshness proof. The trusted existing protected gates must verify receipts.
  return m;
}
// Structural validation grants no authority. A live clock and owner binding
// are supplied by the planner; the storage adapter may check only structure.
export function validateAcceptedPreviewMetadata(m,{now,ownerBinding}={}){
  exact(m,'schema scope ownerBinding sourceIdentitySha256 registrationId registrationSha256 registrationPolicyCommit dataDate sourceDate captureStartedAt captureEndedAt completedAt financialStatus unknownFields');
  if(m.schema!==ACCEPTED_PREVIEW_SCHEMA||m.scope!==OWNER_SCOPE||!hex(m.ownerBinding)||!hex(m.sourceIdentitySha256)
    ||(ownerBinding!==undefined&&(!hex(ownerBinding)||m.ownerBinding!==ownerBinding)))fail('PREVIEW_SCOPE_MISMATCH');
  if(typeof m.registrationId!=='string'||!/^[a-z0-9][a-z0-9-]{7,95}$/.test(m.registrationId)
    ||!hex(m.registrationSha256)||typeof m.registrationPolicyCommit!=='string'||!/^[a-f0-9]{40}$/.test(m.registrationPolicyCommit))fail('PREVIEW_REGISTRATION_INVALID');
  date(m.dataDate);date(m.sourceDate);
  const start=stamp(m.captureStartedAt),end=stamp(m.captureEndedAt),completed=stamp(m.completedAt);
  if((now!==undefined&&!Number.isFinite(now))||start>end||end>completed||(now!==undefined&&completed>now)
    ||m.dataDate<m.sourceDate||Date.parse(m.sourceDate+'T00:00:00.000Z')>start
    ||Date.parse(m.dataDate+'T00:00:00.000+08:00')>completed)fail('PREVIEW_TIME_ORDER');
  if(m.financialStatus!=='partial'||!Array.isArray(m.unknownFields)||!m.unknownFields.length||m.unknownFields.length>32
    ||new Set(m.unknownFields).size!==m.unknownFields.length
    ||m.unknownFields.some(x=>!['orders','holdings','cash','allocation','prices','sourceIdentity','freshness'].includes(x)))fail('PREVIEW_FINANCIAL_STATE');
  return m;
}
const canonical=value=>Array.isArray(value)?value.map(canonical):obj(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export async function previewMetadataSha256(m){
  return sha256(new TextEncoder().encode(JSON.stringify(canonical(m))));
}
function copyBundle(b){
  exact(b,'metadata html receipt');
  if(!(b.html instanceof Uint8Array)||!b.html.length||b.html.length>MAX_BYTES||!(b.receipt instanceof Uint8Array)||!b.receipt.length||b.receipt.length>MAX_RECEIPT_BYTES)fail('SIZE_LIMIT');
  return {metadata:JSON.parse(JSON.stringify(b.metadata)),html:new Uint8Array(b.html),receipt:new Uint8Array(b.receipt)};
}
function copyCurrent(current){
  if(!obj(current)||!['absent','present'].includes(current.state))fail('LATEST_UNKNOWN');
  if(current.state==='absent'){exact(current,'state');return {state:'absent'};}
  if(current.kind==='accepted-preview'){
    exact(current,'state generation kind preview displayBytes');exact(current.preview,'metadata');
    if(!gen(current.generation)||!(current.displayBytes instanceof Uint8Array)||!current.displayBytes.length||current.displayBytes.length>MAX_BYTES)fail('LATEST_INVALID');
    return {state:'present',generation:current.generation,kind:'accepted-preview',
      preview:{metadata:JSON.parse(JSON.stringify(current.preview.metadata))},displayBytes:new Uint8Array(current.displayBytes)};
  }
  exact(current,'state generation bundle displayBytes');
  if(!gen(current.generation)||!(current.displayBytes instanceof Uint8Array)||!current.displayBytes.length||current.displayBytes.length>MAX_BYTES)fail('LATEST_INVALID');
  return {state:'present',generation:current.generation,bundle:copyBundle(current.bundle),displayBytes:new Uint8Array(current.displayBytes)};
}
async function checkedPreview(current,{now,ownerBinding,verifyProtectedPreview,hash,signal}){
  const m=validateAcceptedPreviewMetadata(current.preview.metadata,{now,ownerBinding});
  if(typeof verifyProtectedPreview!=='function')fail('PROTECTED_PREVIEW_GATES_UNAVAILABLE');
  const displaySha256=await hash(current.displayBytes),metadataSha256=await previewMetadataSha256(m);
  const proof=await verifyProtectedPreview({metadata:structuredClone(m),displayBytes:new Uint8Array(current.displayBytes),
    now,phase:'historical-authenticity',signal});
  exact(proof,'schema scope ownerBinding sourceIdentitySha256 registrationId registrationSha256 registrationPolicyCommit displaySha256 metadataSha256');
  if(proof.schema!=='xuan.owner-accepted-preview-proof.v1'||proof.scope!==OWNER_SCOPE||proof.ownerBinding!==ownerBinding
    ||proof.sourceIdentitySha256!==m.sourceIdentitySha256||proof.registrationId!==m.registrationId
    ||proof.registrationSha256!==m.registrationSha256||proof.registrationPolicyCommit!==m.registrationPolicyCommit
    ||proof.displaySha256!==displaySha256||proof.metadataSha256!==metadataSha256)fail('PROTECTED_PREVIEW_GATES_REJECTED');
  return {metadata:m,displaySha256};
}
async function checkedBundle(b,{now,ownerBinding,verifyProtectedReceipt,hash,phase,signal}){
  const c=copyBundle(b);metadata(c.metadata,now,ownerBinding);
  if(await hash(c.html)!==c.metadata.artifactSha256||await hash(c.receipt)!==c.metadata.receiptSha256)fail('HASH_MISMATCH');
  // Candidate admission must apply current source/account/financial/freshness
  // gates. Historical latest needs authenticated original bindings, not a claim
  // that yesterday's capture is fresh now. Both phases require the trusted
  // controller's verifier capability; this module supplies no default proof.
  if(!['candidate-admission','historical-authenticity'].includes(phase))fail('INVALID_VERIFICATION_PHASE');
  if(typeof verifyProtectedReceipt!=='function')fail('PROTECTED_GATES_UNAVAILABLE');
  const proof=await verifyProtectedReceipt({metadata:structuredClone(c.metadata),html:c.html.slice(),receipt:c.receipt.slice(),now,phase,...(signal?{signal}:{})});
  exact(proof,'scope ownerBinding artifactSha256 receiptSha256 sourceIdentitySha256 policyRevision financialStatus');
  if(proof.scope!==OWNER_SCOPE||proof.ownerBinding!==ownerBinding||proof.artifactSha256!==c.metadata.artifactSha256||proof.receiptSha256!==c.metadata.receiptSha256||proof.sourceIdentitySha256!==c.metadata.sourceIdentitySha256||!hex(proof.policyRevision)||proof.financialStatus!==c.metadata.financialStatus)fail('PROTECTED_GATES_REJECTED');
  return c;
}
function compareChronology(candidate,current,generation){
  if(candidate.sourceIdentitySha256!==current.sourceIdentitySha256)fail('SOURCE_IDENTITY_CHANGED');
  for(const key of ['dataDate','sourceDate','captureStartedAt','captureEndedAt'])if(candidate[key]<current[key])fail('STALE_CANDIDATE');
  const sameTime=['sourceDate','captureStartedAt','captureEndedAt'].every(key=>candidate[key]===current[key]);
  if(sameTime&&candidate.artifactSha256!==current.artifactSha256&&!registeredReferenceReplacement(candidate,current,generation))fail('SAME_SOURCE_CONFLICT');
  // Never refresh displayed source times or freshness merely because of a run.
  return candidate.artifactSha256===current.artifactSha256?'no-op':'replace';
}
export async function planOwnerLatest({candidate,current,ownerBinding,now=Date.now(),verifyProtectedReceipt,verifyProtectedPreview,prepareDisplay,hash=sha256,signal}={}){
  try{
    if(!Number.isFinite(now)||!hex(ownerBinding))fail('CONFIG_UNAVAILABLE');
    // Snapshot both public API inputs before the first await, not just inside
    // the synthetic publisher wrapper. Generation stays bound to these bytes.
    const frozenCandidate=copyBundle(candidate),frozenCurrent=copyCurrent(current);
    const next=await checkedBundle(frozenCandidate,{now,ownerBinding,verifyProtectedReceipt,hash,phase:'candidate-admission',signal});
    if(typeof prepareDisplay!=='function')fail('STATIC_RENDERER_UNAVAILABLE');
    const rendered=await prepareDisplay(next.html.slice());
    if(!(rendered instanceof Uint8Array)||!rendered.length||rendered.length>MAX_BYTES)fail('STATIC_RENDERER_REJECTED');
    // Uint8Array.slice may be overridden (Node Buffer.slice aliases memory).
    // Construct a fresh Uint8Array before any asynchronous hash can yield.
    const display=new Uint8Array(rendered);
    const displaySha256=await hash(display);
    let expected='0';
    if(frozenCurrent.state==='absent')exact(frozenCurrent,'state');
    else if(frozenCurrent.kind==='accepted-preview'){
      const previous=await checkedPreview(frozenCurrent,{now,ownerBinding,verifyProtectedPreview,hash,signal});
      if(next.metadata.sourceIdentitySha256!==previous.metadata.sourceIdentitySha256)fail('SOURCE_IDENTITY_CHANGED');
      for(const key of ['dataDate','sourceDate','captureStartedAt','captureEndedAt','completedAt'])
        if(next.metadata[key]<previous.metadata[key])fail('STALE_CANDIDATE');
      const sameTime=['sourceDate','captureStartedAt','captureEndedAt'].every(key=>next.metadata[key]===previous.metadata[key]);
      if(sameTime&&displaySha256!==previous.displaySha256)fail('SAME_SOURCE_CONFLICT');
      expected=frozenCurrent.generation;
      if(displaySha256===previous.displaySha256)return {status:'no-op',code:'IDENTICAL_ARTIFACT'};
    }else{
      const previous=await checkedBundle(frozenCurrent.bundle,{now,ownerBinding,verifyProtectedReceipt,hash,phase:'historical-authenticity',signal});
      const previousRendered=await prepareDisplay(previous.html.slice());
      if(!(previousRendered instanceof Uint8Array)||!previousRendered.length||previousRendered.length>MAX_BYTES)fail('STATIC_RENDERER_REJECTED');
      const previousDisplay=new Uint8Array(previousRendered);
      if(await hash(frozenCurrent.displayBytes)!==await hash(previousDisplay))fail('LATEST_BYTES_MISMATCH');
      expected=frozenCurrent.generation;
      if(compareChronology(next.metadata,previous.metadata,frozenCurrent.generation)==='no-op')return {status:'no-op',code:'IDENTICAL_ARTIFACT'};
    }
    return {status:'ready',code:'CAS_PLAN_READY',target:LATEST_TARGET,ifGenerationMatch:expected,headers:LATEST_HEADERS,bundle:next,display:display.slice(),displaySha256};
  }catch(e){
    let evidence,code;try{if(e&&!nodeTypes.isProxy(e)){evidence=safeOwnerFailureEvidence(Object.getOwnPropertyDescriptor(e,'failureEvidence')?.value);code=Object.getOwnPropertyDescriptor(e,'safeCode')?.value;}}catch{}
    return {status:'blocked',code:typeof code==='string'?code:'VALIDATION_FAILED',...(evidence?{failureEvidence:evidence}:{})};
  }
}
// The controller supplies capabilities, not a JSON assertion of approval. This
// constructor does no I/O, reads no environment and has no default live store.
// Each instance permits at most one transaction, including an uncertain write.
export function createOwnerLatestPublisher({io,ownerBinding,verifyProtectedReceipt,verifyProtectedPreview,prepareDisplay,prepareCommit,
  hash=sha256,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let closed=false;
  return Object.freeze({async publish(candidate){
    if(closed)return {status:'blocked',code:'ONE_SHOT_CLOSED'};
    if(!io||typeof io.readLatest!=='function'||typeof io.replaceLatest!=='function'
      ||typeof io.readLatestGeneration!=='function'||typeof verifyProtectedReceipt!=='function'
      ||typeof prepareDisplay!=='function'||typeof hash!=='function'||typeof now!=='function'
      ||prepareCommit!==undefined&&typeof prepareCommit!=='function'
      ||typeof setTimer!=='function'||typeof clearTimer!=='function'||!hex(ownerBinding))
      return {status:'blocked',code:'CONFIG_UNAVAILABLE'};
    let frozenCandidate;
    try{frozenCandidate=copyBundle(candidate);}catch{return {status:'blocked',code:'CANDIDATE_INVALID'};}
    closed=true;
    const controller=new AbortController();let writing=false,timer,started,rejectDeadline;
    const deadline=new Promise((_,reject)=>{
      rejectDeadline=reject;
      timer=setTimer(()=>{controller.abort();reject(Object.assign(Error('deadline'),{safeCode:'DEADLINE'}));},PREPARATION_DEADLINE_MS);
    });
    const work=async()=>{
      started=now();if(!Number.isFinite(started))fail('CONFIG_UNAVAILABLE');
      let lastClock=started;
      const checkedClock=()=>{const t=now();if(!Number.isFinite(t)||t<lastClock)fail('CLOCK_CHANGED');lastClock=t;return t;};
      const current=copyCurrent(await io.readLatest({target:LATEST_TARGET,signal:controller.signal}));
      if(controller.signal.aborted)fail('DEADLINE');
      const plan=await planOwnerLatest({candidate:frozenCandidate,current,ownerBinding,now:checkedClock(),
        verifyProtectedReceipt,verifyProtectedPreview,prepareDisplay,hash,signal:controller.signal});
      if(plan.status!=='ready')return plan;
      if(controller.signal.aborted||checkedClock()-started>=PREPARATION_DEADLINE_MS)fail('DEADLINE');
      // Slow verified reads and native IAM/canary preparation cannot write.
      // The resulting native admission still expires after five seconds.
      if(prepareCommit)await prepareCommit({signal:controller.signal});
      if(controller.signal.aborted||checkedClock()-started>=PREPARATION_DEADLINE_MS)fail('DEADLINE');
      clearTimer(timer);started=checkedClock();
      timer=setTimer(()=>{controller.abort();rejectDeadline(Object.assign(Error('deadline'),{safeCode:'DEADLINE'}));},DEADLINE_MS);
      const admissionTime=checkedClock(),capture=Date.parse(plan.bundle.metadata.captureStartedAt);
      if(admissionTime<capture||admissionTime>ownerCaptureDeadline(recoveryRequestId(plan.bundle.metadata.receiptObject),plan.bundle.metadata.captureStartedAt,plan.bundle.metadata.captureEndedAt)||new Date(admissionTime+28800000).toISOString().slice(0,10)!==plan.bundle.metadata.dataDate)fail('CANDIDATE_STALE');
      writing=true;
      const ack=await io.replaceLatest({target:LATEST_TARGET,ifGenerationMatch:plan.ifGenerationMatch,
        headers:LATEST_HEADERS,bytes:new Uint8Array(plan.display),
        metadata:{...structuredClone(plan.bundle.metadata),displaySha256:plan.displaySha256},signal:controller.signal});
      if(!obj(ack)||ack.object!==LATEST_TARGET.object||ack.bucket!==LATEST_TARGET.bucket||!gen(ack.generation)
        ||BigInt(ack.generation)<=BigInt(plan.ifGenerationMatch)||ack.size!==plan.display.length)
        return {status:'unknown',code:'WRITE_ACK_UNVERIFIED'};
      if(controller.signal.aborted||checkedClock()-started>=DEADLINE_MS)return {status:'unknown',code:'WRITE_OUTCOME_UNKNOWN'};
      // This is a separate generation-pinned raw-byte GET, never the upload ACK
      // nor the body used for that write. The store validates stored headers.
      const readback=await io.readLatestGeneration({target:LATEST_TARGET,generation:ack.generation,
        sha256:plan.displaySha256,metadata:{...structuredClone(plan.bundle.metadata),displaySha256:plan.displaySha256},signal:controller.signal});
      if(!(readback instanceof Uint8Array)||readback.length!==plan.display.length
        ||await hash(new Uint8Array(readback))!==plan.displaySha256)
        return {status:'unknown',code:'READBACK_UNVERIFIED'};
      if(controller.signal.aborted||checkedClock()-started>=DEADLINE_MS)return {status:'unknown',code:'WRITE_OUTCOME_UNKNOWN'};
      return {status:'published-verified',code:'PINNED_READBACK_VERIFIED',generation:ack.generation,
        sha256:plan.displaySha256,originalArtifactSha256:plan.bundle.metadata.artifactSha256,
        originalReceiptSha256:plan.bundle.metadata.receiptSha256};
    };
    try{return await Promise.race([work(),deadline]);}
    catch(e){
      if(writing&&e?.status===412)return {status:'conflict',code:'CAS_CONFLICT_NO_RETRY'};
      return {status:writing?'unknown':'blocked',code:writing?'WRITE_OUTCOME_UNKNOWN':
        e?.safeCode==='DEADLINE'?'DEADLINE':'READ_OR_VALIDATION_FAILED'};
    }finally{clearTimer(timer);controller.abort();}
  }});
}
