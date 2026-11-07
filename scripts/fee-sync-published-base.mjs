// Private published-base adapter. No default network, credential discovery,
// filesystem access, writer, scheduler or production permission exists here.
// readGithubJson is bound by reviewed integration code to authenticated, bounded
// HTTPS GETs on api.github.com, never supplied by request JSON. Synthetic tests
// replace that transport, not any financial validator. The economic capability
// must be the original instance returned by fetchEconomicSnapshot.
import crypto from 'node:crypto';
import {types} from 'node:util';
import {readPublicationState,weekendGapDates} from './fee-cloud-producer.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {validateFeeCalculationReceiptWithEcon} from './fee-receipt-core.mjs';
import {assertLegacyCopyAuthenticity,V3_LEGACY_COPY_SCHEMA} from './fee-econ-v3-copy.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {validateReportPlan,reportPlanReadiness,selectReportBenchmark,reportWindowDates} from './fee-report-period.mjs';
import {sessionUnion,monthlyArchivesBetween} from './fee-market-calendar.mjs';
import {validateIbManagerReportState,validateIbOwnerBaselineState,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {verifyEconomicSnapshot,readEconomicSnapshotBytes} from './fee-economic-source.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';

const PREFIX='FEE_SYNC_BASE_',failures=new WeakMap(),REPO='/repos/huanwujoy-crypto/fee-console/';
const SHA=/^[a-f0-9]{64}$/,OID=/^[a-f0-9]{40}$/,OWNER='huanwujoy-crypto',OWNER_ID=283054367;
const parser=createLegacyPolicy().parseExactJson;
const verifiers=new WeakSet();
// Identity only: this cannot substitute for readVerifiedBase/current checks.
export const isPublishedBaseVerifier=value=>verifiers.has(value);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const blobHash=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
export const publishedBaseFailureCode=e=>PREFIX+(failures.get(e)||'REFUSED');
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function copy(v){try{hash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('INPUT');}}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail('INPUT');}
function parse(bytes){try{return copy(parser(bytes));}catch{fail('ARTIFACT');}}
function decrypt(bytes,version,key){
  const outer=parse(bytes);exact(outer,['data','enc','v']);
  if(outer.enc!==true||outer.v!==version||typeof outer.data!=='string')fail('ENVELOPE');
  const sealed=Buffer.from(outer.data,'base64');let plain;
  if(sealed.length<29||sealed.toString('base64')!==outer.data)fail('ENVELOPE');
  try{const d=crypto.createDecipheriv('aes-256-gcm',key,sealed.subarray(0,12));d.setAuthTag(sealed.subarray(-16));
    plain=Buffer.concat([d.update(sealed.subarray(12,-16)),d.final()]);return parse(plain);
  }catch{fail('DECRYPT');}finally{plain?.fill(0);sealed.fill(0);}
}
function configOf(options){
  if(!options||types.isProxy(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))fail('CONFIG');
  const ds=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(ds);
  const allowed=['readGithubJson','economicSnapshot','dataKey','baselineSha256','policyProfile','clock'];
  if(keys.length!==allowed.length||keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('CONFIG');
  const c=Object.fromEntries(keys.map(k=>[k,ds[k].value]));
  if(typeof c.readGithubJson!=='function'||types.isProxy(c.readGithubJson)||typeof c.clock!=='function'||types.isProxy(c.clock)
    ||!verifyEconomicSnapshot(c.economicSnapshot)||typeof c.baselineSha256!=='string'||!SHA.test(c.baselineSha256)
    ||types.isProxy(c.dataKey)||!Buffer.isBuffer(c.dataKey)||c.dataKey.length!==32)fail('CONFIG');
  const policy=copy(c.policyProfile);exact(policy,['schema','sourceMode','configuration']);
  if(policy.schema!=='fee-console.sync-policy-profile.v1'||policy.sourceMode!=='sharesight-reference'
    ||!policy.configuration||Array.isArray(policy.configuration)||typeof policy.configuration!=='object')fail('CONFIG');
  return {...c,dataKey:Buffer.from(c.dataKey),policyProfile:policy};
}

// Summary hash definitions are deliberately versioned here, not inherited from
// test fixtures. Checkpoint/coverage hash their complete actual payload objects
// (or null); anchor hashes {ownerBaseline,closingSnapshots}. Benchmark binds the
// original cache bytes, not selected values. Economic SHA is supplied only by
// the original snapshot's authenticated version-binding capability. Policy is
// the actual reviewed profile used to construct the source readers; integration
// must bind that same profile, not a caller-authored hash or claim.
// Reading an authentic historical base does not attest today's synchronization,
// extension coverage or producer budget. Before taking new account captures,
// integration must pass the original history/coverage preconditions and choose
// the correct ordinary-vs-recovery path. Optional coverage is bound here in full;
// only the original report validator can authorize its use for a new target.
export function createPublishedBaseVerifier(options){
  let c;try{c=configOf(options);}catch(e){if(failures.has(e))throw e;fail('CONFIG');}
  let closed=false,busy=false,record=null,lastNow=-1;
  const now=()=>{const n=c.clock();if(!Number.isSafeInteger(n)||n<0||n<lastNow)fail('CLOCK');lastNow=n;return n;};
  const live=()=>{if(closed)fail('CLOSED');};
  const request=async route=>{
    live();
    if(typeof route!=='string'||!(/^(?:git\/ref\/heads\/(?:main|market-data-cache)|git\/matching-refs\/heads\/codex\/fee-daily-\d{8}-|contents\/(?:data\.json|fee-data-health\.json|benchmark-close\.json)\?ref=[a-f0-9]{40}|commits\/[a-f0-9]{40}|actions\/workflows\/validate-fee-data\.yml\/runs\?branch=codex%2Ffee-daily-\d{8}-[a-z0-9]{6}&per_page=5)$/).test(route))fail('ROUTE');
    let timer;
    try{const result=copy(await Promise.race([Promise.resolve().then(()=>c.readGithubJson(Object.freeze({method:'GET',path:REPO+route}))),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),20000);})]));
      live();
      if(route.startsWith('contents/')){
        const name=route.slice('contents/'.length).split('?')[0];
        if(result.type!=='file'||result.path!==name||result.encoding!=='base64'||typeof result.content!=='string'
          ||!Number.isSafeInteger(result.size)||result.size<1||result.size>2*1024*1024||!OID.test(result.sha||''))fail('ARTIFACT');
        const raw=result.content.replaceAll('\n',''),bytes=Buffer.from(raw,'base64');
        if(bytes.length!==result.size||bytes.toString('base64')!==raw||blobHash(bytes)!==result.sha)fail('ARTIFACT');
      }
      return result;}
    catch{fail('TRANSPORT');}finally{clearTimeout(timer);}
  };
  const ref=async name=>{const r=await request('git/ref/heads/'+name);if(!OID.test(r?.object?.sha||''))fail('REFERENCE');return r.object.sha;};
  const signedCommit=async sha=>{
    const x=await request('commits/'+sha);
    const sameOwner=v=>v?.login===OWNER&&v.id===OWNER_ID&&v.type==='User';
    if(x?.sha!==sha||x.commit?.verification?.verified!==true||x.commit.verification.reason!=='valid'||!sameOwner(x.author)
      ||!(sameOwner(x.committer)||(x.committer?.login==='web-flow'&&x.committer.id===19864447)))fail('COMMIT');
  };
  const cacheFile=async sha=>{
    const x=await request('contents/benchmark-close.json?ref='+sha);
    if(x.type!=='file'||x.path!=='benchmark-close.json'||x.encoding!=='base64'||!Number.isSafeInteger(x.size)
      ||x.size<1||x.size>2*1024*1024||typeof x.content!=='string'||!OID.test(x.sha||''))fail('BENCHMARK_ARTIFACT');
    const encoded=x.content.replaceAll('\n',''),bytes=Buffer.from(encoded,'base64');
    if(bytes.length!==x.size||bytes.toString('base64')!==encoded||blobHash(bytes)!==x.sha)fail('BENCHMARK_ARTIFACT');return bytes;
  };
  const checkContext=async r=>{
    live();if(now()>=r.expiresAt)fail('EXPIRED');
    const [main,cache]=await Promise.all([ref('main'),ref('market-data-cache')]);
    if(main!==r.mainSha||cache!==r.cacheSha)fail('CHANGED');
    try{await c.economicSnapshot.checkCurrent();if(c.economicSnapshot.getVersionBinding().sha256!==r.economicSha)fail('CHANGED');}
    catch{fail('ECONOMIC_CHANGED');}
    live();if(now()>=r.expiresAt)fail('EXPIRED');
  };
  const prepare=async raw=>{
    live();const r=copy(raw);exact(r,['targetDate','plan']);
    if(!validateReportPlan(r.plan)||r.plan.kind!=='daily'||r.plan.periodFrom!==r.targetDate
      ||r.plan.accountingThrough!==r.targetDate||r.plan.priceThrough!==r.targetDate)fail('PLAN');
    const started=now();if(reportPlanReadiness(r.plan,new Date(started)).state!=='due')fail('NOT_READY');
    if(record){if(hash(r)!==record.planHash)fail('PLAN_CHANGED');await checkContext(record);return record.view;}
    let economicBytes;
    try{
      await c.economicSnapshot.checkCurrent();
      const version=c.economicSnapshot.getVersionBinding();
      if(version.schema!=='fee-console.economic-source-version.v1'||!SHA.test(version.sha256))fail('ECONOMIC');
      economicBytes=readEconomicSnapshotBytes(c.economicSnapshot);
      const [state,cacheSha]=await Promise.all([readPublicationState(r.targetDate,new Date(started).toISOString(),request,{requireIb:true}),ref('market-data-cache')]);
      if(state.mainSha!==state.finalMainSha||state.pending||!Buffer.isBuffer(state.healthBytes)||!Buffer.isBuffer(state.data))fail('PUBLICATION');
      await signedCommit(state.mainSha);
      // The existing cache workflow uses an unsigned github-actions[bot]
      // commit. Its trust path is the fixed repository/ref, pinned object and
      // Git blob bytes plus original benchmark validation, not owner signing.
      const cacheBytes=await cacheFile(cacheSha),health=parse(state.healthBytes),cache=parse(cacheBytes);
      // This is historical publication evidence, not today's completion signal.
      // Validate its original NY close semantics without imposing a 36-hour
      // freshness window that rejects an ordinary Friday-to-Monday advance.
      const previous=health.targetDate;
      if(validateHealth(health,{now:new Date(health.checkedAt)}).length||!['updated','no-op'].includes(health.outcome)
        ||Date.parse(health.checkedAt)>started+300000||previous>=r.targetDate||health.dataSha256!==digest(state.data)
        ||health.sourceDates.schwab!==previous||health.sourceDates.webull!==previous)fail('HEALTH');
      let window;
      try{window=reportWindowDates(previous,r.targetDate);}catch{fail('RECOVERY_REQUIRED');}
      // This adapter serves the single-target handoff, not period recovery.
      // Prove every intervening date closed in the actual configured markets;
      // an unknown venue/year cannot be inferred closed from a US weekend.
      for(const day of window.slice(0,-1)){
        let sessions;try{sessions=sessionUnion(day,r.plan.markets);}catch{fail('CALENDAR_SCOPE');}
        if(sessions.rows.some(row=>row.state==='unknown')||sessions.state==='unknown')fail('CALENDAR_SCOPE');
        if(sessions.state!=='closed')fail('RECOVERY_REQUIRED');
      }
      // A closed weekend spanning natural month-end still needs its real
      // archive/cutoff plan, which this single-target daily plan does not carry.
      if(monthlyArchivesBetween(previous,r.targetDate).length)fail('RECOVERY_REQUIRED');
      // Even a proved weekday holiday needs the original period-recovery path.
      // Only the original weekend-carry rule can admit gaps in this handoff;
      // no missing valuation, source date or completion receipt is synthesized.
      try{weekendGapDates([{d:previous}],r.targetDate);}catch{fail('RECOVERY_REQUIRED');}
      const payload=decrypt(state.data,3,c.dataKey),economic=decrypt(economicBytes,4,c.dataKey);
      if(economic.v!==4)fail('ECONOMIC');
      try{assertLegacyCopyAuthenticity(economic,c.dataKey);}catch{fail('ECONOMIC');}
      // The legacy-v2 file-origin guard needs a separate authentic original file.
      // Do not silently omit it or open an unapproved path from this adapter.
      if(economic.legacyV3Copy?.schema===V3_LEGACY_COPY_SCHEMA)fail('LEGACY_SOURCE_REQUIRED');
      const fee=payload.feeCalculationReceipt;
      if(fee?.asOf!==previous||!validateFeeCalculationReceiptWithEcon(fee,payload,economic).ok)fail('FEE_RECEIPT');
      let checkpoint,owner;
      try{
        checkpoint=await validateIbManagerReportState(payload,c.baselineSha256);
        owner=await validateIbOwnerBaselineState(payload,c.baselineSha256);
        if(!checkpoint&&!owner)fail('IB_BASELINE');
        if(checkpoint?.ownerBaseline&&owner&&hash(checkpoint.ownerBaseline)!==hash(owner))fail('IB_BASELINE');
        if(checkpoint&&checkpoint.sourceAsOf!==previous)fail('IB_CUTOFF');
        const core=createIbManagerReturnConsumer(),feeView={state:'verified',...fee};
        const ret=await core.project(payload.ibManagerReturnReceipt,feeView,payload.ibManagerSourceStatus);
        const dd=await createIbManagerDrawdownConsumer().project(payload.ibManagerDrawdownReceipt,payload.ibManagerReturnReceipt,feeView,payload.ibManagerSourceStatus);
        if(ret.state!=='verified'||dd.state!=='verified'||ret.asOf!==previous||dd.asOf!==previous)fail('IB_RECEIPT');
      }catch(e){if(failures.has(e))throw e;fail('IB_RECEIPT');}
      const benchmark=selectReportBenchmark(cache,r.targetDate);
      if(benchmark.sourceDate!==r.plan.priceThrough||selectReportBenchmark(cache,previous).sourceDate!==health.sourceDates.benchmark)fail('BENCHMARK');
      const bindings=freeze({mainSha:state.mainSha,baseDataSha256:digest(state.data),baseHealthSha256:digest(state.healthBytes),
        ibBaselineSha256:c.baselineSha256,ibCheckpointSha256:hash(payload.ibManagerSourceState??null),
        ibCoverageSha256:hash(payload.ibManagerCoverageState??null),
        ibAnchorSha256:hash({ownerBaseline:payload.ibManagerBaselineState??null,closingSnapshots:checkpoint?.closingSnapshots??null}),
        economicVersionSha256:version.sha256,benchmarkSha256:digest(cacheBytes),policySha256:hash(c.policyProfile)});
      const next={mainSha:state.mainSha,cacheSha,economicSha:version.sha256,expiresAt:started+300000,planHash:hash(r),
        view:freeze({payload,benchmark,bindings})};
      await checkContext(next);record=next;return next.view;
    }finally{economicBytes?.fill(0);}
  };
  const run=async operation=>{
    live();if(busy)fail('BUSY');busy=true;
    try{return await operation();}catch(e){closed=true;c.dataKey.fill(0);record=null;if(failures.has(e))throw e;fail('REFUSED');}
    finally{busy=false;}
  };
  const verifier=Object.freeze({
    readVerifiedBase:r=>run(()=>prepare(r)),
    verifyPublishedBase:r=>run(async()=>{
      const value=copy(r);exact(value,['payload','benchmark','plan','targetDate','bindings']);
      const view=await prepare({plan:value.plan,targetDate:value.targetDate});
      if(hash(value.payload)!==hash(view.payload)||hash(value.benchmark)!==hash(view.benchmark)||hash(value.bindings)!==hash(view.bindings))fail('BINDINGS');
      return true;
    }),
    close(){closed=true;c.dataKey.fill(0);record=null;},
  });
  verifiers.add(verifier);return verifier;
}
