// Private, review-only historical source revision. No default transport, CLI,
// credentials, files, writer, publication, schedule or consumption mutations.
import {isCalendarDate,inclusiveDays} from './fee-engine.mjs';
import {types} from 'node:util';
import {ibCanonical,IbManagerSourceError,validateIbManagerReportInput} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,validateIbManagerReportState,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {sourceContractInputHash} from './fee-source-contract.mjs';

const core=createIbManagerReturnConsumer();
const controlledErrors=new WeakMap();
const preparedCandidates=new WeakMap();
// Algorithm identity only. Production additionally requires the real published
// artifact capability; a candidate made with synthetic dependencies is not an
// authenticated publication or an execution grant.
export const isIbSourceRevisionCandidate=value=>preparedCandidates.has(value);
const sourceCodes=new Set(['CONFIG','BASELINE_LOCK','BASELINE_MISMATCH','SCOPE','IDENTITY','INCOMPLETE','DATE','DATE_ALIGNMENT','AMOUNT','SCHEMA','CASH_RECONCILIATION','UNRESOLVED_FLOW','UNVERIFIED_TRANSFER','NONCASH_EVIDENCE','UNSUPPORTED_CURRENCY','UNSTABLE','HISTORY_LIMIT','PAST_POINT_CHANGED','STATE','NETWORK']);
const revisionCodes=new Set('ANCHOR ANCHOR_CHANGED ARTIFACT BINDINGS CANDIDATE CANDIDATE_IDENTITY CLOCK CROSS_ANCHOR_PROOF CURRENT_PAYLOAD DEPENDENCY EXPIRED INPUT INPUT_CHANGED LOCKED_DRAWDOWN LOCKED_RETURN MONTH_LOCK NO_HISTORICAL_CHANGE PLAN PREFIX REFUSED REVISED_SCOPE'.split(' '));
const privateCodes=new Set([...revisionCodes,...[...sourceCodes].map(c=>'SOURCE_REFUSED:IB_SOURCE_'+c)]);
const publicCode=code=>'IB_REVISION_'+code.replace(':','_');
export const IB_SOURCE_REVISION_FAILURE_CODES=Object.freeze([...privateCodes].map(publicCode));
export const ibSourceRevisionFailureCode=error=>publicCode(controlledErrors.get(error)||'REFUSED');
const fail=code=>{const fixed=privateCodes.has(code)?code:'REFUSED',error=Error('IB_REVISION_'+fixed);controlledErrors.set(error,fixed);throw Object.freeze(error);};
function sourceCode(error){
  // The existing error's public code is writable. Do not log it without a
  // second allowlist, or invoke an accessor supplied by an external callback.
  if(types.isProxy(error)||!(error instanceof IbManagerSourceError))return 'IB_SOURCE_NETWORK';
  const d=Object.getOwnPropertyDescriptor(error,'code');
  return 'IB_SOURCE_'+(d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&sourceCodes.has(d.value)?d.value:'NETWORK');
}
const same=(a,b)=>ibCanonical(a)===ibCanonical(b);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const oid=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const next=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
// Reuse the bounded plain-JSON check before structuredClone: no getters,
// proxies, custom prototypes or cycles can run while taking the private copy.
function clone(v){try{sourceContractInputHash(v);return structuredClone(v);}catch{fail('INPUT');}}
function artifact(v){
  return exact(v,['dataSha256','healthSha256','producerRunId','candidateSha'])&&sha(v.dataSha256)&&sha(v.healthSha256)
    &&Number.isSafeInteger(v.producerRunId)&&v.producerRunId>0&&oid(v.candidateSha);
}
function planInput(p){
  if(!exact(p,['schema','targetDate','anchorDate','baselineSha256','currentSourceStateId','anchorSourceStateId','currentArtifact','anchorArtifact','bindings','expiresAt'])
    ||!['fee-console.ib-source-revision-plan.v1','fee-console.ib-source-revision-plan.v2'].includes(p.schema)||![p.targetDate,p.anchorDate].every(isCalendarDate)
    ||p.anchorDate>=p.targetDate||inclusiveDays(p.anchorDate,p.targetDate)>9
    ||![p.baselineSha256,p.currentSourceStateId,p.anchorSourceStateId].every(sha)
    ||!artifact(p.currentArtifact)||!artifact(p.anchorArtifact))fail('PLAN');
  // The two admission models are deliberately disjoint. An execution binding
  // cannot stand in for the v1 consumption proof, or vice versa.
  const sync=p.schema==='fee-console.ib-source-revision-plan.v2';
  if(!exact(p.bindings,['mainSha','economicRevisionSha256',...(sync?['admissionModel','executionSha256']:['consumptionSha256']),
      'baseDataSha256','baseHealthSha256','currentSourceStateId'])||!oid(p.bindings.mainSha)
    ||sync&&p.bindings.admissionModel!=='sync-cycle-v1'
    ||![p.bindings.economicRevisionSha256,sync?p.bindings.executionSha256:p.bindings.consumptionSha256,p.bindings.baseDataSha256,p.bindings.baseHealthSha256,p.bindings.currentSourceStateId].every(sha)
    ||p.bindings.baseDataSha256!==p.currentArtifact.dataSha256||p.bindings.baseHealthSha256!==p.currentArtifact.healthSha256
    ||p.bindings.currentSourceStateId!==p.currentSourceStateId||!iso(p.expiresAt))fail('PLAN');
}
function proofsBefore(source,anchor){
  const result={};
  for(const [key,start,end] of [
    ['cashDateNormalizations',p=>p.rawBefore.d,p=>p.rawAfter.d],
    ['incomeDateNormalizations',p=>p.rawAnchor.d,p=>p.rawClosing.d]
  ]){
    const proofs=source[key]||[];
    if(proofs.some(p=>start(p)<=anchor&&end(p)>anchor))fail('CROSS_ANCHOR_PROOF');
    result[key]=proofs.filter(p=>end(p)<=anchor);
  }
  return result;
}
function prefix(source,through){
  const i=source.periodReturnsInput;
  return {baselineFrom:source.baselineFrom,baselineAsOf:source.baselineAsOf,baselineInputsHash:source.baselineInputsHash,
    portfolioIdentityHash:source.portfolioIdentityHash,ownerBaseline:source.ownerBaseline,bootstrapCoverage:source.bootstrapCoverage,
    openT:i.openT,from:i.from,points:i.points.filter(p=>p.d<=through),
    flowByDate:Object.fromEntries(Object.entries(i.flowByDate).filter(([d])=>d<=through)),
    cashFlowByDate:Object.fromEntries(Object.entries(source.cashFlowByDate).filter(([d])=>d<=through)),
    noncashProofs:source.noncashProofs.filter(p=>p.effectiveDate<=through),...proofsBefore(source,through)};
}
function bundleOf(payload){return {returnReceipt:clone(payload.ibManagerReturnReceipt),drawdownReceipt:clone(payload.ibManagerDrawdownReceipt),sourceState:clone(payload.ibManagerSourceState)};}
function locksOf(payload){
  const x=payload.feeReportMonthLocks;if(x===undefined)return [];
  if(!exact(x,['schema','periods'])||x.schema!=='fee-console.report-month-locks.v1'||!Array.isArray(x.periods))fail('MONTH_LOCK');
  const seen=new Set();
  for(const p of x.periods){if(!exact(p,['ym','digest'])||!isCalendarDate(p.ym+'-01')||!sha(p.digest)||seen.has(p.ym))fail('MONTH_LOCK');seen.add(p.ym);}
  return x.periods.map(x=>x.ym).sort();
}
function changedDays(before,after,anchor){
  const changed=new Set();
  for(const p of before.periodReturnsInput.points){
    if(p.d<=anchor)continue;
    const q=after.periodReturnsInput.points.find(q=>q.d===p.d);
    if(!same(p,q)||(before.periodReturnsInput.flowByDate[p.d]||0)!==(after.periodReturnsInput.flowByDate[p.d]||0))changed.add(p.d);
  }
  for(const p of before.closingSnapshots){const q=after.closingSnapshots.find(q=>q.d===p.d);if(q&&p.d>anchor&&!same(p,q))changed.add(p.d);}
  return [...changed].sort();
}
const payloadOf=b=>({ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState});
async function revisionHistory(originalCurrent,originalAnchor,p){
  const current=await validateIbManagerReportState(originalCurrent,p.baselineSha256);
  const anchor=await validateIbManagerReportState(originalAnchor,p.baselineSha256);
  if(!current||!anchor||current.schema!=='fee-console.ib-manager-source.v3'||anchor.schema!=='fee-console.ib-manager-source.v3'
    ||originalCurrent.ibManagerSourceState.stateId!==p.currentSourceStateId||originalAnchor.ibManagerSourceState.stateId!==p.anchorSourceStateId
    ||anchor.sourceAsOf!==p.anchorDate||anchor.sourceAsOf>=current.sourceAsOf||p.targetDate<current.sourceAsOf)fail('ANCHOR');
  if(!same(prefix(current,p.anchorDate),prefix(anchor,p.anchorDate)))fail('PREFIX');
  for(const a of anchor.closingSnapshots){const c=current.closingSnapshots.find(x=>x.d===a.d);if(c&&!same(a,c))fail('ANCHOR_CHANGED');}
  const locks=locksOf(originalCurrent);
  if(locks.some(ym=>ym>=next(p.anchorDate).slice(0,7)&&ym<=current.sourceAsOf.slice(0,7)))fail('MONTH_LOCK');
  return {current,anchor,locks};
}
async function revisionCalculation(originalCurrent,p,history,revised){
  const {current,anchor,locks}=history;
  revised=validateIbManagerReportInput(clone(revised),p.baselineSha256);
  if(revised.schema!=='fee-console.ib-manager-source.v3'||revised.sourceAsOf!==p.targetDate
    ||!same(prefix(revised,p.anchorDate),prefix(anchor,p.anchorDate)))fail('REVISED_SCOPE');
  const replacement=await buildIbManagerReportBundle(revised,p.baselineSha256),changes=changedDays(current,revised,p.anchorDate);
  if(!changes.length)fail('NO_HISTORICAL_CHANGE');
  for(const ym of locks){
    if(!same(originalCurrent.ibManagerReturnReceipt.periods.filter(x=>x.ym===ym),replacement.returnReceipt.periods.filter(x=>x.ym===ym)))fail('LOCKED_RETURN');
    const before=originalCurrent.ibManagerDrawdownReceipt.dailyFactors,after=replacement.drawdownReceipt.dailyFactors;
    const count=current.periodReturnsInput.points.filter(x=>x.d.slice(0,7)<=ym).length;
    if(!same(before.slice(0,count),after.slice(0,count)))fail('LOCKED_DRAWDOWN');
  }
  return {replacement,changes};
}
async function revisionBody(originalCurrent,originalAnchor,p,history,{replacement,changes},checkedAt){
  const {current}=history;
  const body={schema:'fee-console.ib-source-revision-candidate.v1',mode:p.targetDate===current.sourceAsOf?'same-cutoff':'extend-cutoff',
    plan:p,checkedAt,changedHistoricalDates:changes,oldThrough:current.sourceAsOf,anchorDate:p.anchorDate,targetDate:p.targetDate,
    superseded:bundleOf(originalCurrent),acceptedAnchor:bundleOf(originalAnchor),replacement,
    scope:'ib-manager-only',oldArtifactsPreserved:true,publicationReady:false,executionAuthorized:false};
  return freeze({...body,revisionId:await core.digest(body)});
}

// Pure content verification for the existing private producer -> writer handoff.
// This deliberately does not authenticate serialized artifacts or grant a run.
// The producer must first authenticate the original in-memory candidate through
// the real artifact adapter. The child independently checks the old IB state,
// whole rebuilt bundle, plan, dates, coverage and lock boundaries before use.
export async function validateIbSourceRevisionCandidate(candidate,{currentPayload,targetDate,baselineSha256,now}={}){
  try{
    const c=clone(candidate),previous=clone(currentPayload);
    if(!exact(c,['schema','mode','plan','checkedAt','changedHistoricalDates','oldThrough','anchorDate','targetDate','superseded','acceptedAnchor','replacement','scope','oldArtifactsPreserved','publicationReady','executionAuthorized','revisionId'])
      ||!sha(baselineSha256)||!Number.isSafeInteger(now)||now<0||!iso(c.checkedAt)
      ||Date.parse(c.checkedAt)>now||c.targetDate!==targetDate||c.plan?.baselineSha256!==baselineSha256)fail('CANDIDATE');
    planInput(c.plan);
    if(now>=Date.parse(c.plan.expiresAt)||Date.parse(c.checkedAt)>=Date.parse(c.plan.expiresAt))fail('EXPIRED');
    if(!same(bundleOf(previous),c.superseded))fail('CURRENT_PAYLOAD');
    const anchorPayload=payloadOf(c.acceptedAnchor),history=await revisionHistory(previous,anchorPayload,c.plan);
    const calculation=await revisionCalculation(previous,c.plan,history,c.replacement?.sourceState?.source);
    const rebuilt=await revisionBody(previous,anchorPayload,c.plan,history,calculation,c.checkedAt);
    if(!same(rebuilt,c))fail('CANDIDATE');
    return rebuilt;
  }catch(error){if(controlledErrors.has(error))throw error;fail('REFUSED');}
}

// A single in-process handoff, not a production budget. Wrong arguments do not
// make a serialized copy authentic. The full original payload is bound here;
// the downstream writer separately compares its unchanged prior IB bundle.
export async function consumeIbSourceRevisionCandidate(candidate,{currentPayload,targetDate,baselineSha256,now}={}){
  const record=preparedCandidates.get(candidate);
  if(!record||record.consumed)fail('CANDIDATE_IDENTITY');
  record.consumed=true;
  try{
    if(sourceContractInputHash(currentPayload)!==record.currentHash)fail('CURRENT_PAYLOAD');
    return await validateIbSourceRevisionCandidate(candidate,{currentPayload,targetDate,baselineSha256,now});
  }catch(error){if(controlledErrors.has(error))throw error;fail('REFUSED');}
}

// Dependencies must be bound by reviewed trusted code, never chosen from JSON.
// verifyAcceptedArtifacts must verify BOTH original published artifacts and
// their payload bytes, using existing authenticated read-only evidence. Returning
// hashes or a self-authored verified flag alone does not meet that obligation.
// This module only constructs a candidate. Even a valid result grants no read,
// decryption, execution budget, historical amendment or publication permission.
export function createIbSourceRevisionPreparer({verifyAcceptedArtifacts,readStable,checkCurrent,clock=Date.now}={}){
  if([verifyAcceptedArtifacts,readStable,checkCurrent,clock].some(f=>typeof f!=='function'))fail('DEPENDENCY');
  let previousNow=-1;
  return Object.freeze({async prepare(request){
    try{
    const inputs=clone(request);
    if(!exact(inputs,['currentPayload','anchorPayload','plan']))fail('INPUT');
    const {currentPayload:originalCurrent,anchorPayload:originalAnchor,plan:p}=inputs;planInput(p);
    const checkTime=()=>{
      const n=clock();if(!Number.isSafeInteger(n)||n<0||n<previousNow)fail('CLOCK');previousNow=n;
      if(n>=Date.parse(p.expiresAt))fail('EXPIRED');return n;
    };
    checkTime();
    const history=await revisionHistory(originalCurrent,originalAnchor,p),{anchor}=history;
    const expectedArtifacts={current:p.currentArtifact,anchor:p.anchorArtifact};
    if(!same(clone(await verifyAcceptedArtifacts(freeze({currentPayload:clone(originalCurrent),anchorPayload:clone(originalAnchor),expected:clone(expectedArtifacts)}))),expectedArtifacts))fail('ARTIFACT');
    if(!same(clone(await checkCurrent()),p.bindings))fail('BINDINGS');checkTime();
    let revised;
    try{
      revised=await readStable(freeze({targetDate:p.targetDate,expectedBaselineHash:p.baselineSha256,
        baseline:{from:anchor.baselineFrom,asOf:anchor.baselineAsOf},checkpoint:clone(anchor)}));
    }catch(e){fail('SOURCE_REFUSED:'+sourceCode(e));}
    const calculation=await revisionCalculation(originalCurrent,p,history,revised);
    if(!same(clone(await checkCurrent()),p.bindings))fail('BINDINGS');const checkedAt=new Date(checkTime()).toISOString();
    if(!same(clone(request),inputs))fail('INPUT_CHANGED');
    const candidate=await revisionBody(originalCurrent,originalAnchor,p,history,calculation,checkedAt);
    checkTime();if(!same(clone(request),inputs))fail('INPUT_CHANGED');
    preparedCandidates.set(candidate,{currentHash:sourceContractInputHash(originalCurrent),consumed:false});
    return candidate;
    }catch(error){if(controlledErrors.has(error))throw error;fail('REFUSED');}
  }});
}
