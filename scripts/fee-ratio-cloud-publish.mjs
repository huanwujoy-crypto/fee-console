import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
// Pure publication orchestration. Fixed-service IO is supplied explicitly;
// tests use memory-only fakes. The runtime owns credentials and bounded transport.
import crypto from 'node:crypto';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {buildRatioModel} from './fee-ratio-packet.mjs';
import {feePublicationFailureCode,validateFeeHandoff} from './fee-ratio-fee-publication.mjs';

export const RATIO_CLOUD_FILE='fee-console-ratio-snapshot.json';
const MAX=5*1024*1024;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const refuse=()=>{throw Error('RATIO_CLOUD_REFUSED');};
const parse=b=>createLegacyPolicy().parseExactJson(b);
function bytes(value){
  if(!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>MAX)refuse();
  return Buffer.from(value);
}
function pinnedObject(spec,prefix,file){
  if(!exact(spec,['name','generation','sha256'])||spec.name!==prefix+file||typeof spec.generation!=='string'||!/^\d{1,30}$/.test(spec.generation)||/^0+$/.test(spec.generation)||!hex(spec.sha256))refuse();
}
// `fee` is the coordinator's handoff of the already published fee report this
// ratio follows (fee main, accounting cutoff, data/health byte hashes). It is
// an identity to verify, never a date the ratio source must match: every
// official source keeps its own real date. The round binding is the capture
// itself: the pinned original's frozen earliest capture must not precede the
// handed-over, hash-verified fee health's checkedAt (a lower bound of that fee
// production). This keeps "fee first, then ratio" for the handed fee. It does
// not prove the handed fee is this round's: an older fee that is still live may
// be handed over explicitly, so the coordinator must check that the handoff is
// the round's approved fee target before dispatch. A capture mtime is also not
// proof of a new official export.
export function validateRatioCloudPlan(plan){
  if(!exact(plan,['mode','previousBodySha256','bundleId','original','input','library','fee'])||!['verify-current','publish'].includes(plan.mode)||!hex(plan.previousBodySha256))refuse();
  if(plan.mode==='verify-current'){
    if([plan.bundleId,plan.original,plan.input,plan.library,plan.fee].some(v=>v!==null))refuse();
    return;
  }
  if(!validateFeeHandoff(plan.fee))refuse();
  if(!hex(plan.bundleId)||!exact(plan.library,['fileId','version'])||!/^libfile_[a-f0-9]{32}$/.test(plan.library.fileId)||!Number.isSafeInteger(plan.library.version)||plan.library.version<0)refuse();
  const prefix='inputs/'+plan.bundleId+'/';
  pinnedObject(plan.original,prefix,'original.json');pinnedObject(plan.input,prefix,'input.json');
}

export function createRatioCloudPublisher({exposureCore=createRankedExposureCore()}={}){
  const ratio=createFeeRatioCore(exposureCore,crypto.webcrypto);
  const snapshot=createRatioSnapshotCore(ratio,exposureCore,createRatioSourceCore,parse,crypto.webcrypto);
  const profile=()=>ratio.digest([createAggregateReturnsCore.toString(),createOfficialRatioSourceCore.toString(),createFeeCompanyExposureCore.toString(),createRatioSnapshotCore.toString(),createRatioSourceCore.toString(),createFeeRatioCore.toString(),createRankedExposureCore.toString()]);
  function destination(v,identity){
    if(!exact(v,['id','ownerId','authenticatedUserId','public','revision','recipientBytes','snapshotBytes'])||v.id!==identity.gistId||v.ownerId!==identity.ownerId||v.authenticatedUserId!==identity.ownerId||v.public!==false||typeof v.revision!=='string'||!/^[a-f0-9]{40,64}$/.test(v.revision))refuse();
    return {...v,recipientBytes:bytes(v.recipientBytes),snapshotBytes:bytes(v.snapshotBytes)};
  }
  async function current(raw,manager,expected,now){
    const recipient=await ratio.validateRecipient(parse(raw.recipientBytes));
    if(ratio.canonical(recipient)!==ratio.canonical(manager.recipient))refuse();
    const packet=parse(raw.snapshotBytes),result=await snapshot.verify(packet,manager,{now});
    if(expected!==null&&result.watermark.id!==expected)refuse();
    return {packet,result};
  }
  async function prepare({plan,originalBytes,inputBytes,manager,previous,now}){
    const raw=parse(originalBytes),input=parse(inputBytes);
    if(sha(originalBytes)!==plan.original.sha256||sha(inputBytes)!==plan.input.sha256||!((raw.schemaVersion==='sharesight-private-full-v2'&&input.schema==='fee-console.ratio-sources.v2')||(raw.schemaVersion==='sharesight-private-performance-v1'&&input.schema==='fee-console.ratio-sources.v3')))refuse();
    // Exact approved Library identity and version are bound to the uploaded
    // object's hash/generation by the future transport. A hash is not consent.
    const source=createRatioSourceCore(accounts=>sha(JSON.stringify(accounts.map(s=>s.replaceAll('&amp;','&')).sort())));
    const facts=source.verifyBrowserSourceAssociations(raw,input,{scopeHash:exposureCore.ALL_TOGETHER_SCOPE_SHA256,now});
    const model=await buildRatioModel(input,{kind:'snapshot',targetDate:input.exposure.summary.asOf,feeAccountingThrough:null,now,viewCore:ratio,previewOnly:true});
    const {companyExposure,sourceDates,classificationSummary,performance,...association}=facts;
    const capturedAt=Date.parse(association.observedAt);if(!Number.isFinite(capturedAt))refuse();
    model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-library-association',associationId:await ratio.digest([plan.original.sha256,plan.input.sha256,plan.library,manager.recipient.scopeId]),managerScopeId:manager.recipient.scopeId,sourceVersion:plan.library.version,migrationPending:association.migrationPending,classificationDeltaCents:association.classificationDeltaCents,exposureDeltaCents:association.exposureDeltaCents};
    model.companyExposure=companyExposure;model.sourceDates=sourceDates;model.classificationSummary=classificationSummary;if(performance)model.performance=performance;
    const proof=await snapshot.verifyOriginal({originalBytes,inputBytes,model,recipient:manager.recipient,sourceSha256:plan.original.sha256,inputSha256:plan.input.sha256,libraryVersion:plan.library.version,now});
    if(previous.body.source.sourceSha256===proof.evidence.sourceSha256&&previous.body.source.inputSha256===proof.evidence.inputSha256) return {sameSource:true};
    const candidate=await snapshot.candidate({model,recipient:manager.recipient,proof,previous,now});
    const signed=await snapshot.authenticate(candidate,proof,manager,{previous,profileSha256:await profile(),now});
    await snapshot.verify(signed,manager,{now});
    return {sameSource:false,signed,capturedAt};
  }

  // Caller holds the approved fixed-destination capability. In this local
  // candidate there is deliberately no way to obtain one from an environment.
  // All transport operations must be bounded, no-retry and fixed-service.
  async function run({plan,identity,manager,io,clock=()=>new Date()}){
    const receipt={schema:'fee-console.ratio-cloud-safe-result.v1',status:'REFUSED',stage:'PLAN',claim:'NOT_ATTEMPTED',patchAttempts:0,bodySha256:null,contentSha256:null,cleanup:'NOT_RUN'};
    let claimed=false,sourceRead=false,originalBytes=null,inputBytes=null;
    let selectedPlan;
    const time=()=>{const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))refuse();return at;};
    // A proof must be the one just returned: same handoff, not from the future.
    const feeProof=proof=>{
      const verified=Date.parse(proof?.verifiedAt);
      if(!proof||typeof proof!=='object'||proof.feeMainSha!==plan.fee.mainSha||proof.accountingThrough!==plan.fee.accountingThrough
        ||proof.dataSha256!==plan.fee.dataSha256||proof.healthSha256!==plan.fee.healthSha256
        ||!Number.isFinite(verified)||verified>time().getTime()+300000)refuse();
      return proof;
    };
    const read=async()=>destination(await io.readDestination(RATIO_CLOUD_FILE),identity);
    const readFee=async input=>{try{return await io.verifyFeePublication(input);}catch(error){
      receipt.stage+=':'+feePublicationFailureCode(error);refuse();
    }};
    try{await (async()=>{
      validateRatioCloudPlan(plan);plan=structuredClone(plan);selectedPlan=plan;identity=structuredClone(identity);
      if(!exact(identity,['gistId','ownerId'])||typeof identity.gistId!=='string'||!/^(?:[a-f0-9]{20}|[a-f0-9]{32})$/.test(identity.gistId)||!Number.isSafeInteger(identity.ownerId)||identity.ownerId<=0)refuse();
      receipt.stage='CURRENT';
      const before=await read(),prior=await current(before,manager,plan.previousBodySha256,time());
      receipt.bodySha256=prior.result.watermark.id;
      if(plan.mode==='verify-current'){receipt.status='VERIFIED_CURRENT_NO_WRITE';return;}
      receipt.stage='INPUT';sourceRead=true;
      const get=async spec=>{
        const got=await io.readInput(structuredClone(spec));
        if(!exact(got,['generation','bytes'])||got.generation!==spec.generation)refuse();
        const b=bytes(got.bytes);if(sha(b)!==spec.sha256){b.fill(0);refuse();}return b;
      };
      originalBytes=await get(plan.original);inputBytes=await get(plan.input);
      receipt.stage='SOURCE';
      const prepared=await prepare({plan,originalBytes,inputBytes,manager,previous:prior.packet,now:time()});
      if(prepared.sameSource){receipt.status='UNCHANGED_SOURCE_NO_WRITE';return;}
      // A successful producer job or candidate is not a published fee report.
      // The fixed runtime verifies the handed-over fee publication on the
      // pinned and live main and on Pages, validates the real fee/Jenny
      // receipts in memory, and returns a process-local proof. The ratio keeps
      // its own source dates; the fee cutoff comes only from the handoff.
      receipt.stage='FEE_READBACK';
      if(typeof io.verifyFeePublication!=='function')refuse();
      const firstFee=feeProof(await readFee({handoff:structuredClone(plan.fee)}));
      // Same-round capture, decided before any claim can be consumed.
      receipt.stage='SOURCE_ROUND';
      const roundStart=Date.parse(firstFee.healthCheckedAt);
      if(!Number.isFinite(roundStart)||prepared.capturedAt<roundStart)refuse();
      const raw=Buffer.from(JSON.stringify(prepared.signed));
      receipt.bodySha256=await ratio.digest(prepared.signed.body);receipt.contentSha256=sha(raw);
      // The claim key binds the input pair and previous accepted body, not a
      // mutable run ID, main SHA or object generation that could reset it.
      const claimKey=await ratio.digest([plan.previousBodySha256,plan.original.sha256,plan.input.sha256]);
      receipt.stage='CLAIM';receipt.claim='UNKNOWN';
      const claim=await io.claimOnce('claims/'+claimKey+'.json',{bodySha256:receipt.bodySha256,contentSha256:receipt.contentSha256},{ifGenerationMatch:0});
      if(claim!=='CREATED'){receipt.claim=claim==='EXISTS'?'EXISTS':'UNKNOWN';refuse();}
      receipt.claim='OWNED';claimed=true;
      receipt.stage='PREWRITE';
      const check=await read();
      if(check.revision!==before.revision||!check.snapshotBytes.equals(before.snapshotBytes)||!check.recipientBytes.equals(before.recipientBytes))refuse();
      await current(check,manager,plan.previousBodySha256,time());
      if(time().getTime()>Date.parse(prepared.signed.body.source.expiresAt))refuse();
      receipt.stage='FEE_RECHECK';
      // Re-read the same final publication; a changed main/report, a stale
      // receipt, or an unavailable Pages readback cannot release this claim.
      // Never wait here for another producer job while holding its concurrency
      // group, and never generate a fee report to satisfy this prerequisite.
      feeProof(await readFee({handoff:structuredClone(plan.fee),previousProof:firstFee}));
      if(time().getTime()>Date.parse(prepared.signed.body.source.expiresAt))refuse();
      receipt.stage='WRITE_INTENT';
      // An atomic durable safe receipt must exist before the only PATCH.
      await io.saveReceipt(structuredClone(receipt));
      if(time().getTime()>Date.parse(prepared.signed.body.source.expiresAt))refuse();
      receipt.stage='READBACK';receipt.patchAttempts=1;
      try{await io.patchSnapshot({files:{[RATIO_CLOUD_FILE]:{content:raw.toString('utf8')}}});}catch{/* Request outcome may be unknown. Never resend. */}
      try{
        const back=await read();
        if(!back.snapshotBytes.equals(raw)||!back.recipientBytes.equals(before.recipientBytes))refuse();
        await current(back,manager,receipt.bodySha256,time());
        receipt.status='PUBLISHED_CONFIRMED';receipt.stage='COMPLETE';
      }catch{receipt.status='WRITE_UNCONFIRMED';}
      raw.fill(0);
    })();}catch{
      if(receipt.patchAttempts)receipt.status='WRITE_UNCONFIRMED';
      else if(receipt.stage==='FEE_READBACK'||receipt.stage.startsWith('FEE_READBACK:'))receipt.status='WAITING_FEE_READBACK_NO_WRITE';
      // No exception message, stack, URL, token, body or account reaches output.
    }
    return finish();

    async function finish(){
      originalBytes?.fill(0);inputBytes?.fill(0);
      try{
        await io.cleanupLocal();
        if(claimed)await io.deleteInputs([selectedPlan.original,selectedPlan.input].map(x=>structuredClone(x)));
        receipt.cleanup=claimed?'LOCAL_AND_PINNED_INPUTS':'LOCAL_ONLY';
      }catch{receipt.cleanup='INCOMPLETE';}
      // Unknown/failed claims never delete another execution's source objects.
      if(!sourceRead&&receipt.cleanup==='LOCAL_ONLY')receipt.cleanup='NO_INPUTS_READ';
      try{await io.saveReceipt(structuredClone(receipt));}catch{throw Error('RATIO_CLOUD_SAFE_RECEIPT_UNSAVED');}
      return Object.freeze({...receipt});
    }
  }
  return {run};
}
