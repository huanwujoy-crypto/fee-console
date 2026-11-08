// Shared, in-memory synchronization/report admission. No transport, credential
// discovery, writer, scheduler or historical correction is supplied here.
import {types} from 'node:util';
import {createSourceContractValidator,sourceContractInputHash,sourceContractFailureCode} from './fee-source-contract.mjs';
import {projectSharesightSyncAccount} from './fee-sync-source-projection.mjs';
import {isSyncDatePolicyGate,syncDateFailureCode,SYNC_DATE_RECEIPT_SCHEMA} from './fee-sync-date-policy.mjs';

const PREFIX='FEE_SYNC_READY_',errors=new WeakMap();
const ROLES=['ib-manager','schwab','webull'];
const HASH=/^[a-f0-9]{64}$/,CYCLE=/^[A-Za-z0-9_.:-]{1,128}$/;
function fail(code){const e=new Error(PREFIX+code);errors.set(e,code);throw Object.freeze(e);}
export const syncReadinessFailureCode=e=>PREFIX+(errors.get(e)||'REFUSED');
// Fixed evidence item names only (never values) for a WAITING sync-date admission.
const waitingEvidence=new WeakMap();
export const syncReadinessMissingEvidence=e=>waitingEvidence.get(e)||null;
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function copy(v){
  // The existing bounded copier rejects getters/proxies, symbols, non-JSON
  // prototypes, cycles and unsafe numbers before stringify can invoke them.
  try{sourceContractInputHash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('SCHEMA');}
}
const hash=sourceContractInputHash;
const same=(a,b)=>hash(a)===hash(b);
function exact(v,keys,code='SCHEMA'){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail(code);
}
function utc(v){
  const n=typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)?Date.parse(v):NaN;
  if(!Number.isFinite(n)||new Date(n).toISOString()!==v)fail('DATE');return n;
}
function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('DATE');return v;}
function roles(rows){
  if(!Array.isArray(rows)||rows.length!==3)fail('SCOPE');
  const sorted=[...rows].sort((a,b)=>String(a.role).localeCompare(String(b.role)));
  if(sorted.some((a,i)=>a.role!==ROLES[i]))fail('SCOPE');return sorted;
}
function history(rows,target){
  return roles(rows).map(r=>{
    exact(r,['role','through','semanticSha256'],'HISTORY');day(r.through);
    if(r.through>target||typeof r.semanticSha256!=='string'||!HASH.test(r.semanticSha256))fail('HISTORY');return r;
  });
}
function currentFor(r,executionId,validatorDependencyHash){
  return {executionId,validatorDependencyHash,targetDate:r.targetDate,plan:r.plan,
    sourceSet:r.sourceSet,inputSha256:hash(r.inputs),bindings:r.bindings};
}
function sameCurrent(actual,expected){
  const a=copy(actual),e=copy(expected);
  // sourceSet order has no meaning; retain all other fields, including extras.
  if(!Array.isArray(a.sourceSet))fail('CURRENT');
  const sort=x=>({...x,sourceSet:[...x.sourceSet].sort((a,b)=>String(a.role).localeCompare(String(b.role)))});
  if(!same(sort(a),sort(e)))fail('CURRENT');return a;
}

export function createUnifiedSourceReadiness(options){
  let config;
  try{
    if(!options||types.isProxy(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))fail('CONFIG');
    const d=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(d);
    const allowed=['executionId','validatorDependencyHash','clock','maxAgeMs','verifySynchronization','validateOriginalSources','readCurrentContext','syncDatePolicy'];
    if(keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))fail('CONFIG');
    config=Object.fromEntries(keys.map(k=>[k,d[k].value]));
    for(const key of ['verifySynchronization','validateOriginalSources','readCurrentContext'])
      if(typeof config[key]!=='function'||types.isProxy(config[key]))fail('CONFIG');
    // Optional future sync-date gate; absent means the unchanged v1 contract.
    if(Object.hasOwn(config,'syncDatePolicy')&&!isSyncDatePolicyGate(config.syncDatePolicy))fail('CONFIG');
    config.clock??=Date.now.bind(Date);config.maxAgeMs??=300000;
    if(typeof config.clock!=='function'||types.isProxy(config.clock)||!Number.isSafeInteger(config.maxAgeMs)||config.maxAgeMs<1||config.maxAgeMs>900000)fail('CONFIG');
  }catch(e){if(errors.has(e))throw e;fail('CONFIG');}
  const {executionId,validatorDependencyHash,clock,maxAgeMs,verifySynchronization,validateOriginalSources,readCurrentContext,syncDatePolicy=null}=config;
  const validated=new WeakMap(),handles=new WeakMap();
  const checkNow=()=>{let n;try{n=clock();}catch{fail('CLOCK');}if(!Number.isSafeInteger(n)||n<0)fail('CLOCK');return n;};
  const validate=async c=>{
    const x=c.inputs;exact(x,['schema','cycleId','accounts','publishedHistory']);
    if(x.schema!=='fee-console.sync-input.v1'||typeof x.cycleId!=='string'||!CYCLE.test(x.cycleId))fail('SCHEMA');
    const sources=roles(c.sourceSet),accounts=roles(x.accounts),projections=[];
    for(let i=0;i<accounts.length;i++){
      const a=accounts[i];exact(a,['role','scope','raw','captureSourceSha256','validatedInputSha256']);
      if(['captureSourceSha256','validatedInputSha256'].some(k=>typeof a[k]!=='string'||!HASH.test(a[k])))fail('SOURCE_BINDING');
      if(a.scope?.role!==a.role||a.scope?.targetDate!==c.targetDate||a.scope?.fromDate!==sources[i].fromDate)fail('SCOPE');
      let p;try{p=projectSharesightSyncAccount({scope:a.scope,raw:a.raw});}catch{fail('SOURCE');}
      if(hash(p.identity)!==sources[i].identitySha256||p.sourceSha256!==sources[i].evidenceSha256)fail('SOURCE_BINDING');
      projections.push(p);
    }
    // The bound adapter must authenticate the synchronization system's final
    // receipt and its immutable published history. Input JSON cannot supply or
    // select this verifier. A self-authored matched:true is never sufficient.
    let receipt;try{receipt=copy(await verifySynchronization(freeze({cycleId:x.cycleId,targetDate:c.targetDate,sourceSet:c.sourceSet,bindings:c.bindings})));}catch{fail('SYNC_EVIDENCE');}
    // A target on/after an explicit cutover requires the v2 receipt with its
    // China sync sessions; every other target keeps the v1 receipt unchanged.
    const dated=syncDatePolicy?.appliesTo(c.targetDate)===true;
    exact(receipt,['schema','cycleId','targetDate','completedAt','accounts','publishedHistory',...(dated?['syncSession']:[])],'SYNC_EVIDENCE');
    if(receipt.schema!==(dated?SYNC_DATE_RECEIPT_SCHEMA:'fee-console.verified-sync.v1')||receipt.cycleId!==x.cycleId||receipt.targetDate!==c.targetDate)fail('SYNC_EVIDENCE');
    const now=checkNow(),completed=utc(receipt.completedAt);
    if(completed>now||now-completed>maxAgeMs)fail('SYNC_EXPIRED');
    const accepted=roles(receipt.accounts);
    for(let i=0;i<accepted.length;i++){
      const a=accepted[i];exact(a,['role','state','unresolved','projection','captureSourceSha256','validatedInputSha256'],'SYNC_EVIDENCE');
      if(a.state!=='complete'||!Array.isArray(a.unresolved)||a.unresolved.length!==0)fail('SYNC_INCOMPLETE');
      const p=projections[i],old=a.projection;
      if(!old||!same(old.identity,p.identity))fail('IDENTITY');
      if(!same(old.holdings,p.holdings))fail('POSITIONS');
      if(!same(old.cash,p.cash))fail('NATIVE_CASH');
      if(!same(old.trades,p.trades)||!same(old.cashEvents,p.cashEvents)||!same(old.payouts,p.payouts))fail('EVENTS');
      if(!same(old,p))fail('SOURCE_CHANGED');
      if(a.captureSourceSha256!==accounts[i].captureSourceSha256)fail('SOURCE_CHANGED');
      if(a.validatedInputSha256!==accounts[i].validatedInputSha256)fail('VALIDATED_INPUT_CHANGED');
    }
    // These are newly observed historical semantic digests versus authenticated
    // accepted digests, not two copies selected by a request. Any disagreement
    // stops ordinary admission; no automatic revision module is called.
    if(!same(history(x.publishedHistory,c.targetDate),history(receipt.publishedHistory,c.targetDate)))fail('HISTORY_CHANGED');
    let syncDate=null;
    if(dated){
      try{syncDate=await syncDatePolicy.check({targetDate:c.targetDate,receiptSession:receipt.syncSession,projections,
        publishedHistory:receipt.publishedHistory,capturedAt:c.capturedAt,now})}
      catch(e){
        const code=syncDateFailureCode(e),out=new Error(PREFIX+'SYNC_DATE_'+(code||'SCHEMA'));errors.set(out,'SYNC_DATE_'+(code||'SCHEMA'));
        if(Array.isArray(e?.missingEvidence))waitingEvidence.set(out,Object.freeze([...e.missingEvidence]));throw Object.freeze(out);
      }
    }
    let prepared;
    try{prepared=copy(await validateOriginalSources(freeze({...c,projections})));}catch{fail('ORIGINAL_VALIDATION');}
    exact(prepared,['schema','targetDate','inputSha256','calculationInputs'],'ORIGINAL_VALIDATION');
    if(prepared.schema!=='fee-console.prepared-sources.v1'||prepared.targetDate!==c.targetDate||prepared.inputSha256!==c.inputSha256)fail('ORIGINAL_VALIDATION');
    validated.set(c.inputs,syncDate?freeze({...prepared,syncDateAdmission:syncDate}):prepared);return true;
  };
  try{createSourceContractValidator({executionId,validatorDependencyHash,clock,maxAgeMs,validate});}catch{fail('CONFIG');}
  const current=async expected=>{
    let v;try{v=await readCurrentContext();}catch{fail('CURRENT');}
    return sameCurrent(v,expected);
  };
  const prepare=async request=>{
    try{
    const r=copy(request),expected=currentFor(r,executionId,validatorDependencyHash);
    await current(expected);
    let handle,inputs,reason,waiting=null;
    // Per-admission closure preserves fixed business reasons without placing
    // raw validation exceptions in the generic capability or sharing mutable
    // error state between simultaneous admissions.
    const contract=createSourceContractValidator({executionId,validatorDependencyHash,clock,maxAgeMs,validate:async c=>{
      try{return await validate(c);}catch(e){reason=errors.get(e)||'ORIGINAL_VALIDATION';waiting=waitingEvidence.get(e)||null;throw e;}
    }});
    try{handle=await contract.validateInputs(r);inputs=contract.consumeValidatedInputs(handle,await current(expected));}
    catch(e){if(errors.has(e))throw e;
      if(reason){const out=new Error(PREFIX+reason);errors.set(out,reason);if(waiting)waitingEvidence.set(out,waiting);throw Object.freeze(out);}const code=sourceContractFailureCode(e);fail(code==='FEE_SOURCE_CONTRACT_EXPIRED'?'EXPIRED':'VALIDATION');}
    const prepared=validated.get(inputs);if(!prepared)fail('ORIGINAL_VALIDATION');
    handles.set(handle,{expected,prepared,contract});return handle;
    }catch(e){if(errors.has(e))throw e;fail('SCHEMA');}
  };
  return Object.freeze({
    // Both entry points execute exactly the same deterministic rules. A second
    // process must verify its evidence anew; handles cannot cross processes.
    validateForSynchronization:prepare,
    validateForReport:prepare,
    async consumeForReport(handle){
      const record=handles.get(handle);if(!record)fail('HANDLE');
      const c=await current(record.expected);
      try{record.contract.consumeValidatedInputs(handle,c);}catch{fail('EXPIRED_OR_CHANGED');}
      return record.prepared;
    }
  });
}
