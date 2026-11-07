// In-process source-validation capability only. No IO, credentials, producer or
// publication entry point. The trusted coordinator owns the factory/validator;
// a supplied dependency hash does not attest what arbitrary JavaScript does.
// Current bindings must come from the coordinator's real checks, not the old
// contract. Neither a hash nor this handle proves Sharesight stayed unchanged.
import {createHash} from 'node:crypto';
import {types} from 'node:util';

const PREFIX='FEE_SOURCE_CONTRACT_';
const failures=new WeakMap();
const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const MAX_BYTES=4*1024*1024,MAX_NODES=100000,MAX_DEPTH=64;
const BINDINGS=Object.freeze(['mainSha','baseDataSha256','baseHealthSha256',
  'ibBaselineSha256','ibCheckpointSha256','ibCoverageSha256','ibAnchorSha256',
  'economicVersionSha256','benchmarkSha256','policySha256']);
const ROLES=Object.freeze(['ib-manager','schwab','webull']);
const realNow=Date.now.bind(Date);

function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
function safeError(error,fallback){if(failures.has(error))throw error;fail(fallback);}
export function sourceContractFailureCode(error){return PREFIX+(failures.get(error)||'REFUSED');}

// Never invoke user accessors, toJSON, iterators or Proxy traps while copying.
// Copy first, then freeze all context, before calling the bound validator.
function snapshot(value){
  let nodes=0,characters=0;const ancestors=new Set();
  const copy=(v,depth)=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)fail('JSON');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){characters+=v.length;if(characters>MAX_BYTES)fail('JSON');return v;}
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0)||Math.abs(v)>Number.MAX_SAFE_INTEGER)fail('JSON');return v;}
    if(typeof v!=='object'||types.isProxy(v)||ancestors.has(v))fail('JSON');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('JSON');
    const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
    if(keys.some(k=>typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)))fail('JSON');
    ancestors.add(v);let out;
    if(array){
      const size=descriptors.length?.value;
      if(!Number.isSafeInteger(size)||size<0||size>MAX_NODES||keys.length!==size+1)fail('JSON');
      out=[];
      for(let i=0;i<size;i++){
        const d=descriptors[String(i)];
        if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('JSON');
        out.push(copy(d.value,depth+1));
      }
    }else{
      out={};
      for(const key of keys.sort()){
        const d=descriptors[key];characters+=key.length;
        if(characters>MAX_BYTES||!Object.hasOwn(d,'value')||!d.enumerable)fail('JSON');
        Object.defineProperty(out,key,{value:copy(d.value,depth+1),enumerable:true});
      }
    }
    ancestors.delete(v);return Object.freeze(out);
  };
  try{
    const result=copy(value,0);
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_BYTES)fail('JSON');
    return result;
  }catch(error){safeError(error,'JSON');}
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceContractInputHash=value=>digest(snapshot(value));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function exact(value,keys,code='SCHEMA'){
  if(!object(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(code);
}
function day(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('DATE');
  const n=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)fail('DATE');
  return value;
}
function utcTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))fail('TIME');
  const n=Date.parse(value);if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==value)fail('TIME');return n;
}
function planShape(plan,targetDate){
  const v2=plan?.schema==='fee-console.report-plan.v2';
  exact(plan,['schema','kind','periodFrom','accountingThrough','priceThrough','scheduledAt','monthlyCutoffs',...(v2?['markets']:[])],'PLAN');
  if(!['fee-console.report-plan.v1','fee-console.report-plan.v2'].includes(plan.schema)
    ||!(v2?['daily','daily-monthly']:['weekly','monthly','weekly-monthly']).includes(plan.kind))fail('PLAN');
  day(plan.periodFrom);day(plan.accountingThrough);day(plan.priceThrough);
  if(plan.accountingThrough!==targetDate||plan.periodFrom>targetDate||plan.priceThrough>targetDate)fail('PLAN');
  if(typeof plan.scheduledAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(plan.scheduledAt)
    ||!Number.isFinite(Date.parse(plan.scheduledAt)))fail('PLAN');
  day(plan.scheduledAt.slice(0,10));
  if(!Array.isArray(plan.monthlyCutoffs)||plan.monthlyCutoffs.some((d,i)=>day(d)<plan.periodFrom||d>targetDate||(i&&d<=plan.monthlyCutoffs[i-1])))fail('PLAN');
  if(v2&&(!Array.isArray(plan.markets)||!plan.markets.length||plan.markets.length>16||plan.markets.some((m,i)=>typeof m!=='string'||!(/^[A-Z][A-Z0-9_-]{0,23}$/).test(m)||(i&&m<=plan.markets[i-1]))))fail('PLAN');
  // This checks shape/date binding, not trading calendars or month-end close.
  // The bound validator must use the original validateReportPlan/ source rules;
  // runtime readiness and publication checks remain outside this capability.
}
function contextOf(value){
  const {targetDate,plan,sourceSet,bindings}=value;day(targetDate);planShape(plan,targetDate);
  exact(bindings,BINDINGS,'BINDINGS');
  if(typeof bindings.mainSha!=='string'||!COMMIT.test(bindings.mainSha)||BINDINGS.slice(1).some(k=>typeof bindings[k]!=='string'||!SHA.test(bindings[k])))fail('BINDINGS');
  if(!Array.isArray(sourceSet)||sourceSet.length!==ROLES.length)fail('SOURCE_SET');
  for(const s of sourceSet){exact(s,['role','identitySha256','evidenceSha256','fromDate','sourceDate'],'SOURCE_SET');if(typeof s.role!=='string')fail('SOURCE_SET');}
  const sorted=[...sourceSet].sort((a,b)=>a.role.localeCompare(b.role));
  for(let i=0;i<sorted.length;i++){
    const s=sorted[i];exact(s,['role','identitySha256','evidenceSha256','fromDate','sourceDate'],'SOURCE_SET');
    if(s.role!==ROLES[i]||typeof s.identitySha256!=='string'||!SHA.test(s.identitySha256)||typeof s.evidenceSha256!=='string'||!SHA.test(s.evidenceSha256))fail('SOURCE_SET');
    day(s.fromDate);day(s.sourceDate);
    if(s.sourceDate!==targetDate||s.fromDate>plan.periodFrom)fail('SOURCE_SET');
  }
  return snapshot({targetDate,plan,sourceSet:sorted,bindings});
}
function execution(value){if(typeof value!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(value))fail('EXECUTION');return value;}

export function createSourceContractValidator(options){
  // Function injection is for a trusted coordinator and synthetic tests only;
  // untrusted data cannot choose a validator, clock, dependency hash or run id.
  let config;
  try{
    if(!options||types.isProxy(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))fail('CONFIG');
    const d=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(d);
    if(keys.some(k=>typeof k!=='string'||!['executionId','validatorDependencyHash','validate','clock','maxAgeMs'].includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))fail('CONFIG');
    config=Object.fromEntries(keys.map(k=>[k,d[k].value]));
    execution(config.executionId);
    if(typeof config.validatorDependencyHash!=='string'||!SHA.test(config.validatorDependencyHash)
      ||typeof config.validate!=='function'||types.isProxy(config.validate))fail('CONFIG');
    if(config.clock===undefined)config.clock=realNow;
    if(config.maxAgeMs===undefined)config.maxAgeMs=300000;
    if(typeof config.clock!=='function'||types.isProxy(config.clock)||!Number.isSafeInteger(config.maxAgeMs)||config.maxAgeMs<1||config.maxAgeMs>900000)fail('CONFIG');
  }catch(error){safeError(error,'CONFIG');}
  const {executionId,validatorDependencyHash,validate,clock,maxAgeMs}=config;
  const records=new WeakMap();let previousNow=-1;
  const time=()=>{
    let n;try{n=clock();}catch{fail('CLOCK');}
    if(!Number.isSafeInteger(n)||n<0||n<previousNow)fail('CLOCK');previousNow=n;return n;
  };
  const lifetime=(record,n)=>{
    if(n<record.capturedMs||n<record.checkedMs)fail('TIME');
    if(n>=record.expiresMs||n-record.capturedMs>maxAgeMs)fail('EXPIRED');
  };
  return Object.freeze({
    async validateInputs(request){
      try{
        const r=snapshot(request);
        exact(r,['targetDate','plan','sourceSet','inputs','bindings','capturedAt','expiresAt']);
        const context=contextOf(r),capturedMs=utcTime(r.capturedAt),expiresMs=utcTime(r.expiresAt);
        if(expiresMs<=capturedMs||expiresMs-capturedMs>maxAgeMs)fail('TIME');
        const start=time(),record={capturedMs,checkedMs:start,expiresMs};lifetime(record,start);
        const inputSha256=digest(r.inputs);
        const validation=snapshot({...context,inputs:r.inputs,inputSha256,executionId,validatorDependencyHash,
          capturedAt:r.capturedAt,expiresAt:r.expiresAt});
        let result;try{result=await validate(validation);}catch{fail('VALIDATION');}
        if(result!==true)fail('VALIDATION');
        record.checkedMs=time();lifetime(record,record.checkedMs);
        const handle=Object.freeze(Object.create(null));
        records.set(handle,{...record,contextSha256:digest(context),inputSha256,inputs:validation.inputs});
        return handle;
      }catch(error){safeError(error,'REFUSED');}
    },
    consumeValidatedInputs(handle,current){
      try{
        const record=records.get(handle);if(!record)fail('HANDLE');
        const c=snapshot(current);
        exact(c,['executionId','validatorDependencyHash','targetDate','plan','sourceSet','inputSha256','bindings']);
        if(execution(c.executionId)!==executionId)fail('EXECUTION');
        if(c.validatorDependencyHash!==validatorDependencyHash)fail('VERSION');
        if(typeof c.inputSha256!=='string'||!SHA.test(c.inputSha256)||c.inputSha256!==record.inputSha256)fail('INPUT_CHANGED');
        if(digest(contextOf(c))!==record.contextSha256)fail('BINDING_CHANGED');
        lifetime(record,time());
        // Repeat reads are allowed, not repeat production. Existing live budget,
        // single-writer, source-change, cutoff, calculation and readback gates
        // are mandatory. This method cannot reserve or authorize a write.
        return record.inputs;
      }catch(error){safeError(error,'REFUSED');}
    }
  });
}
