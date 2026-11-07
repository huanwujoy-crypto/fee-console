// Private, in-memory synchronization handoff. This coordinator consumes source
// captures already validated by the original readers. It never reads an account,
// discovers credentials, writes a report, schedules work or grants a run budget.
import {types} from 'node:util';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {createUnifiedSourceReadiness,syncReadinessFailureCode} from './fee-sync-readiness.mjs';
import {projectCapturedSharesightAccount} from './fee-sync-captured-inputs.mjs';
import {prepareIbManagerReportInput} from './ib-manager-report.mjs';
import {validateReportPlan,reportPlanReadiness} from './fee-report-period.mjs';
import {SharesightCloudReader} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader} from './ib-manager-source.mjs';

const failures=new WeakMap(),PREFIX='FEE_SYNC_CYCLE_';
function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
export const syncCycleFailureCode=e=>PREFIX+(failures.get(e)||'REFUSED');
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function copy(v){try{hash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('INPUT');}}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail('INPUT');}
function captureList(value){
  if(!value||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail('CAPTURE');
  const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
  // This ordinary daily handoff intentionally excludes bootstrap reconstruction.
  if(ds.length?.value!==1||keys.length!==2||!ds['0']||!Object.hasOwn(ds['0'],'value')||!ds['0'].enumerable)fail('CAPTURE');
  return [ds['0'].value];
}

// Executable dependencies must be selected by the reviewed trusted coordinator,
// never by a JSON request. In particular, verifyPublishedBase authenticates the
// payload against the bound encrypted artifact; an echoed hash is insufficient.
export function createCapturedSyncCycle(options){
  let config;
  try{
    if(!options||types.isProxy(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))fail('CONFIG');
    const ds=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(ds);
    const allowed=['feeReader','ibReader','executionId','validatorDependencyHash','clock','maxAgeMs','verifySynchronization','verifyPublishedBase','readCurrentContext'];
    if(keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('CONFIG');
    config=Object.fromEntries(keys.map(k=>[k,ds[k].value]));
    for(const key of ['verifySynchronization','verifyPublishedBase','readCurrentContext'])if(typeof config[key]!=='function'||types.isProxy(config[key]))fail('CONFIG');
    for(const [key,Type] of [['feeReader',SharesightCloudReader],['ibReader',SharesightIbManagerReader]]){
      const reader=config[key];if(!reader||types.isProxy(reader)||!Type.prototype.isPrototypeOf(reader))fail('CONFIG');
    }
    if(config.feeReader.sourceMode!=='sharesight-reference')fail('CONFIG');
    config.clock??=Date.now.bind(Date);
    if(typeof config.clock!=='function'||types.isProxy(config.clock))fail('CONFIG');
  }catch(e){if(failures.has(e))throw e;fail('CONFIG');}
  const {feeReader,ibReader,clock,verifyPublishedBase}=config;
  const verifyFee=c=>Reflect.apply(SharesightCloudReader.prototype.verifyCapturedRead,feeReader,[c]);
  const verifyIb=c=>Reflect.apply(SharesightIbManagerReader.prototype.verifyCapturedRead,ibReader,[c]);
  let started=false;
  return Object.freeze({async prepare(options){
    // A cycle is a one-shot preparation. Failure never causes another read or a
    // fresh opportunity; the original evidence and consumed run history remain.
    if(started)fail('ALREADY_PREPARED');started=true;
    try{
      if(!options||types.isProxy(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))fail('INPUT');
      const ds=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(ds);
      const allowed=['request','feeCapture','ibCaptures','scopes','benchmark','ibPayload','ibEnviron'];
      if(keys.length!==allowed.length||keys.some(k=>typeof k!=='string'||!allowed.includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('INPUT');
      const {request,feeCapture,ibCaptures,scopes,benchmark,ibPayload,ibEnviron}=Object.fromEntries(keys.map(k=>[k,ds[k].value]));
      const r=copy(request),s=copy(scopes),b=copy(benchmark),payload=copy(ibPayload),env=copy(ibEnviron);
      const captures=captureList(ibCaptures);
      exact(r,['targetDate','plan','bindings','capturedAt','expiresAt','cycleId','publishedHistory']);
      exact(env,['IB_MANAGER_READ_ENABLED','IB_MANAGER_BASELINE_SHA256']);
      if(env.IB_MANAGER_READ_ENABLED!=='true'||env.IB_MANAGER_BASELINE_SHA256!==r.bindings.ibBaselineSha256)fail('BASE');
      if(!validateReportPlan(r.plan)||r.plan.accountingThrough!==r.targetDate||r.plan.priceThrough!==r.targetDate)fail('PLAN');
      if(r.plan.kind!=='daily'||r.plan.periodFrom!==r.targetDate)fail('PLAN_SCOPE');
      if(reportPlanReadiness(r.plan,new Date(clock())).state!=='due')fail('NOT_READY');
      if(!Array.isArray(s)||s.length!==3||s.some(x=>x.targetDate!==r.targetDate))fail('SCOPE');
      if(captures.some(c=>!verifyIb(c))||!verifyFee(feeCapture))fail('CAPTURE');
      const byDate=new Map();
      for(const c of captures){const d=c.evidence.targetDate;if(byDate.has(d))fail('CAPTURE');byDate.set(d,c);}
      const finalIb=byDate.get(r.targetDate);if(!finalIb)fail('CAPTURE');
      const projected=s.map(scope=>{
        const reader=scope.role==='ib-manager'?ibReader:feeReader,captured=scope.role==='ib-manager'?finalIb:feeCapture;
        return projectCapturedSharesightAccount({reader,captured,scope});
      });
      const accounts=projected.map(a=>({role:a.scope.role,scope:a.scope,raw:a.raw,captureSourceSha256:a.captureSourceSha256,validatedInputSha256:a.validatedInputSha256}));
      const full={targetDate:r.targetDate,plan:r.plan,bindings:r.bindings,capturedAt:r.capturedAt,expiresAt:r.expiresAt,
        sourceSet:projected.map(a=>({role:a.scope.role,identitySha256:hash(a.projection.identity),evidenceSha256:a.projection.sourceSha256,
          fromDate:a.scope.fromDate,sourceDate:a.scope.targetDate})),
        inputs:{schema:'fee-console.sync-input.v1',cycleId:r.cycleId,accounts,publishedHistory:r.publishedHistory}};
      const used=new Set();
      const gate=createUnifiedSourceReadiness({executionId:config.executionId,validatorDependencyHash:config.validatorDependencyHash,
        clock,...(config.maxAgeMs===undefined?{}:{maxAgeMs:config.maxAgeMs}),verifySynchronization:config.verifySynchronization,
        readCurrentContext:config.readCurrentContext,validateOriginalSources:async c=>{
          if(await verifyPublishedBase({payload,benchmark:b,plan:c.plan,targetDate:c.targetDate,bindings:c.bindings})!==true)fail('BASE');
          // These consume the original readers' same-instance capabilities and
          // check every original read parameter. They perform no HTTP request.
          const fee=Reflect.apply(SharesightCloudReader.prototype.consumeCapturedRead,feeReader,[feeCapture,c.targetDate,b]);
          if(fee.targetDate!==c.targetDate||fee.sourceDates?.schwab!==c.targetDate||fee.sourceDates?.webull!==c.targetDate)fail('CAPTURE');
          if(accounts.some(a=>a.role!=='ib-manager'&&a.validatedInputSha256!==hash(fee)))fail('CAPTURE');
          const ib=await prepareIbManagerReportInput({payload,targetDate:c.targetDate,environ:env,reader:{readStable(args){
            const found=byDate.get(args.targetDate);if(!found||used.has(found))fail('CAPTURE');
            const input=Reflect.apply(SharesightIbManagerReader.prototype.consumeCapturedRead,ibReader,[found,args]);used.add(found);return input;
          }}});
          if(ib?.state!=='verified'||used.size!==captures.length)fail('IB_PENDING');
          if(accounts.find(a=>a.role==='ib-manager').validatedInputSha256!==hash(ib.source))fail('CAPTURE');
          return {schema:'fee-console.prepared-sources.v1',targetDate:c.targetDate,inputSha256:c.inputSha256,calculationInputs:{fee,ib}};
        }});
      const handle=await gate.validateForSynchronization(full);
      return Object.freeze({
        // No serializable receipt can recreate this private closure.
        consumeForReport:()=>gate.consumeForReport(handle),
      });
    }catch(e){
      if(failures.has(e))throw e;
      const code=syncReadinessFailureCode(e);
      if(code!=='FEE_SYNC_READY_REFUSED')fail(code.replace('FEE_SYNC_READY_','READINESS_'));
      fail('VALIDATION');
    }
  }});
}
