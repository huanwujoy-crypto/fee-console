// Offline-only candidate. No CLI, network, writer, dispatch or publication authority.
// Production adapters/permissions and protected promotion integration are absent.
import {validateCompletion,assertSameBinding,sha256} from './fee-completion-policy.mjs';
import {buildCashDisclosure} from './fee-completion-disclosure.mjs';
import {resolveFeeSessionTarget} from './fee-session-target.mjs';
import {selectBenchmark} from './fee-cloud-source.mjs';
const fail=code=>{throw Error(`FEE_EARLY_${code}`);};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const issuers=Object.freeze({schwab:'schwab-gmail-sync-runtime@family-portfolio-gateway.iam.gserviceaccount.com',webull:'webull-gmail-sync-runtime@family-portfolio-gateway.iam.gserviceaccount.com'});
// Caller is the future reviewed fixed authenticated adapter, never arbitrary
// user-supplied JSON. The validator cannot manufacture provider authentication.
export async function prepareEarlyFeePlan({enabled=false,resolveTarget=()=>resolveFeeSessionTarget(now),readPair,readDestination,benchmarkCache,now=new Date(),receiptMaxAgeMs,cashMaxAgeMs,cashPolicy='require-independent'}={}) {
 if(!enabled)return {state:'DISABLED'};
 if(![resolveTarget,readPair,readDestination].every(x=>typeof x==='function'))fail('ADAPTER_REQUIRED');
 const target=await resolveTarget(now);
 if(!date(target?.targetDate)||target.targetTimezone!=='America/New_York'||!hash(target.calendarSha256)||target.lastCompletedSession!==target.targetDate)fail('TARGET_UNVERIFIED');
 const day=new Date(+now+8*3600000).toISOString().slice(0,10);
 if(target.targetDate>=day||+now-Date.parse(target.targetDate+'T00:00:00Z')>7*86400000)fail('TARGET_STALE');
 const options={targetDate:target.targetDate,now,receiptMaxAgeMs,cashMaxAgeMs,cashPolicy};
 function verify(pair){
  if(!Array.isArray(pair)||pair.length!==2)fail('PAIR');
  const results=[],bindings=[];
  for(const broker of ['schwab','webull']){
   const items=pair.filter(x=>x?.receipt?.broker===broker);if(items.length!==1)fail('PAIR');
   const item=items[0];
   if(item.authenticatedProvider!==issuers[broker]||!hash(item.receiptHash)||item.receiptHash!==sha256(JSON.stringify(item.receipt))
      ||!/^\d+$/.test(item.receiptGeneration||'')||!/^\d+$/.test(item.pointerGeneration||''))fail('TRANSPORT_BINDING');
   results.push(validateCompletion(item.receipt,{...options,authenticatedProvider:item.authenticatedProvider}));
   bindings.push({broker,receiptHash:item.receiptHash,receiptGeneration:item.receiptGeneration,pointerGeneration:item.pointerGeneration,destinationFingerprint:item.receipt.destinationFingerprint});
  }
  return {results,bindings};
 }
 const before=verify(await readPair(target.targetDate));
 const destination=await readDestination(target.targetDate);
 for(const b of before.bindings)if(destination[b.broker]!==b.destinationFingerprint)fail('DESTINATION_CHANGED');
 const after=verify(await readPair(target.targetDate));assertSameBinding(before.bindings,after.bindings);
 let benchmark=null;
 // Only complete same-target rows unlock a bundle. Malformed caches fail closed;
 // a valid cache missing one/both target rows is pending, never older-price carry.
 if(benchmarkCache!==undefined){try{benchmark=selectBenchmark(benchmarkCache,target.targetDate);}catch(e){if(e.message!=='FEE_CLOUD_BENCHMARK_PENDING')throw e;}}
 return {schema:'fee.early-publication-plan.v1',state:'OFFLINE_PLAN_ONLY',targetDate:target.targetDate,
  benchmarkState:benchmark?'session':'pending',benchmark,sourceBenchmarkDate:benchmark?target.targetDate:null,
  brokerCoverage:before.results,bindings:before.bindings,
  brokerCashDisclosure:buildCashDisclosure(before.results,target.targetDate),
  requiredRechecks:['before-writer','before-candidate','protected-promotion'],
  writerMode:'existing-daily-with-private-economic-ledger',activationAllowed:false};
}
export function earlyFeeClockDecision({now,plan,producerActive=false,candidatePending=false,publicationPending=false,leaseHeld=false,attemptUncertain=false,corePublished=false,benchmarkPublished=false}={}){
 if(!(now instanceof Date)||!Number.isFinite(+now))fail('CLOCK_TIME');
 const hkt=new Date(+now+8*3600000),minute=hkt.getUTCHours()*60+hkt.getUTCMinutes();
 if(hkt.getUTCDay()<2||hkt.getUTCDay()>6||minute<660||minute>1080)return 'outside_window';
 if(producerActive||candidatePending||publicationPending||leaseHeld||attemptUncertain)return 'wait_existing';
 if(plan?.state!=='OFFLINE_PLAN_ONLY')return minute>=690?'alert_completion_blocked':'wait_completion';
 if(!corePublished)return 'request_core_after_activation';
 if(plan.benchmarkState==='session'&&!benchmarkPublished)return 'request_same_target_replacement_after_activation';
 return 'published_core_benchmark_pending_or_complete';
}
