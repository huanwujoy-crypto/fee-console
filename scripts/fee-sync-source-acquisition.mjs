// Same-process, read-only source acquisition after the authenticated base and
// original history/coverage preflight. No default network, environment, key
// discovery, synchronization assertion, producer permission or writer exists.
import {types} from 'node:util';
import {SharesightCloudReader,CLOUD_ACCOUNTS} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader} from './ib-manager-source.mjs';
import {prepareIbManagerReportInput} from './ib-manager-report.mjs';
import {isPublishedBaseVerifier} from './fee-sync-published-base.mjs';
import {projectCapturedSharesightAccount} from './fee-sync-captured-inputs.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';

const errors=new WeakMap(),PREFIX='FEE_SYNC_ACQUIRE_';
function fail(code){const e=new Error(PREFIX+code);errors.set(e,code);throw Object.freeze(e);}
export const sourceAcquisitionFailureCode=e=>PREFIX+(errors.get(e)||'REFUSED');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function copy(v){try{hash(v);return freeze(JSON.parse(JSON.stringify(v)));}catch{fail('INPUT');}}
function properties(value,keys,code){
  if(!value||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
  const ds=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(ds);
  if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail(code);
  return Object.fromEntries(own.map(k=>[k,ds[k].value]));
}
const nextDay=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function ibScope(capture,args){
  const rows=capture.evidence.captures[0].records.filter(r=>r.method==='GET'&&r.path==='/api/v2/portfolios.json'&&Object.keys(r.query).length===0);
  if(rows.length!==1)fail('SCOPE');
  const matches=JSON.parse(rows[0].body).portfolios.filter(p=>p.name==='IB-HK'&&p.currency_code==='USD');
  if(matches.length!==1)fail('SCOPE');
  const prior=args.checkpoint?.sourceAsOf||args.ownerBaseline?.input?.periodReturnsInput?.to;
  const fromDate=prior?nextDay(prior):args.baseline.from;
  return {role:'ib-manager',name:'IB-HK',portfolioId:matches[0].id,targetDate:args.targetDate,fromDate};
}

export function createVerifiedSourceAcquisition(options){
  let c;
  try{
    c=properties(options,['feeReader','ibReader','publishedBase','clock'],'CONFIG');
    if(!isPublishedBaseVerifier(c.publishedBase)||typeof c.clock!=='function'||types.isProxy(c.clock))fail('CONFIG');
    for(const [reader,Type] of [[c.feeReader,SharesightCloudReader],[c.ibReader,SharesightIbManagerReader]])
      if(!reader||types.isProxy(reader)||!Type.prototype.isPrototypeOf(reader))fail('CONFIG');
    if(Reflect.apply(SharesightCloudReader.prototype.getPolicyBinding,c.feeReader,[]).sourceMode!=='sharesight-reference')fail('CONFIG');
    // Private-brand check without any credentials, account request or capture.
    Reflect.apply(SharesightIbManagerReader.prototype.verifyCapturedRead,c.ibReader,[null]);
  }catch(e){if(errors.has(e))throw e;fail('CONFIG');}
  let started=false,closed=false,busy=false,record=null,lastNow=-1;
  const now=()=>{const n=c.clock();if(!Number.isSafeInteger(n)||n<0||n<lastNow)fail('CLOCK');lastNow=n;return n;};
  const live=()=>{if(closed)fail('CLOSED');};
  const currentPolicy=capture=>Reflect.apply(SharesightCloudReader.prototype.getPolicyBinding,c.feeReader,capture?[capture]:[]);
  const policyCurrent=r=>{
    live();if(now()>=r.expiresAt)fail('EXPIRED');
    if(hash(currentPolicy(r.feeCapture))!==r.base.bindings.policySha256)fail('POLICY');
  };
  const baseCurrent=async r=>{
    policyCurrent(r);
    if(await c.publishedBase.verifyPublishedBase({...r.request,...r.base})!==true)fail('BASE');
    policyCurrent(r);
  };
  const checkCurrent=async()=>{
    live();if(!record)fail('NOT_CAPTURED');if(busy)fail('BUSY');busy=true;const active=record;
    try{
      await baseCurrent(active);
      // One fee capability serves both fee accounts. Never re-read it twice.
      await Reflect.apply(SharesightCloudReader.prototype.checkCapturedReadCurrent,c.feeReader,[active.feeCapture]);
      policyCurrent(active);
      await Reflect.apply(SharesightIbManagerReader.prototype.checkCapturedReadCurrent,c.ibReader,[active.ibCapture]);
      await baseCurrent(active);return true;
    }catch(e){closed=true;record=null;if(errors.has(e))throw e;fail('CHANGED');}
    finally{busy=false;}
  };
  return Object.freeze({
    async capture(request){
      live();if(started)fail('ALREADY_STARTED');started=true;busy=true;
      try{
        const r=copy(properties(request,['targetDate','plan'],'INPUT')),startedAt=now();
        const base=await c.publishedBase.readVerifiedBase(r);
        const next={request:r,base,expiresAt:startedAt+300000,feeCapture:null,ibCapture:null};
        // readVerifiedBase has just performed the full authenticated current
        // check. Avoid repeating metadata IO before the pure IB preflight.
        policyCurrent(next);
        const environ=freeze({IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:base.bindings.ibBaselineSha256});
        let ibArgs=null;
        // Original validation owns the first-read decision. Invalid coverage,
        // history, baseline or unfinished bootstrap never starts a source read.
        const prepared=await prepareIbManagerReportInput({payload:base.payload,targetDate:r.targetDate,environ,reader:{readStable:async args=>{
          if(ibArgs||args.targetDate!==r.targetDate||(!args.checkpoint&&args.bootstrapCoverage))fail('RECOVERY_REQUIRED');
          await baseCurrent(next);ibArgs=copy(args);
          next.ibCapture=await Reflect.apply(SharesightIbManagerReader.prototype.readStableWithEvidence,c.ibReader,[args]);
          return next.ibCapture.input;
        }}});
        if(prepared?.state!=='verified'||!next.ibCapture||!ibArgs)fail('IB_PREFLIGHT');
        policyCurrent(next);
        next.feeCapture=await Reflect.apply(SharesightCloudReader.prototype.readStableWithEvidence,c.feeReader,[r.targetDate,base.benchmark]);
        await baseCurrent(next);
        const scopes=freeze([ibScope(next.ibCapture,ibArgs),...['schwab','webull'].map(role=>({role,...CLOUD_ACCOUNTS[role],targetDate:r.targetDate,fromDate:r.targetDate}))]);
        const projected=freeze(scopes.map(scope=>projectCapturedSharesightAccount({scope,reader:scope.role==='ib-manager'?c.ibReader:c.feeReader,captured:scope.role==='ib-manager'?next.ibCapture:next.feeCapture})));
        const inputs=freeze({targetDate:r.targetDate,plan:r.plan,bindings:base.bindings,benchmark:base.benchmark,ibPayload:base.payload,ibEnviron:environ,
          feeCapture:next.feeCapture,ibCaptures:[next.ibCapture],scopes,projected,capturedAt:new Date(startedAt).toISOString(),expiresAt:new Date(next.expiresAt).toISOString()});
        record=next;
        // The handle deliberately serializes to {}. Captures remain private and
        // unconsumed for the existing unified cycle, which STILL requires an
        // authenticated synchronization receipt and accepted-history evidence.
        return Object.freeze({async readCapturedInputs(){await checkCurrent();return inputs;}});
      }catch(e){closed=true;record=null;if(errors.has(e))throw e;fail('VALIDATION');}
      finally{busy=false;}
    },
    close(){closed=true;record=null;},
  });
}
