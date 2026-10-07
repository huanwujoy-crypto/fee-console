// Approved business policy; activation and IAM remain disabled pending review.
import {SCHWAB_CASH_DISCLOSURE} from './fee-completion-disclosure.mjs';
export const CASH_POLICIES=Object.freeze(['require-independent','allow-estimated-covered']);
const fail=code=>{throw Error(`FEE_COMPLETION_CASH_${code}`);};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
export function cashPolicyConfig(env={}){
 const policy=env.FEE_COMPLETION_CASH_POLICY||'require-independent';
 if(!CASH_POLICIES.includes(policy))fail('POLICY');return policy;
}
export function evaluateCashCoverage(r,{cashPolicy='require-independent',targetDate,now,cashMaxAgeMs}={}){
 if(!CASH_POLICIES.includes(cashPolicy))fail('POLICY');
 const c=r.cashProof,independentCashVerified=c?.matchStatus==='MATCHED';
 if(Object.hasOwn(r,'independentCashVerified')&&(typeof r.independentCashVerified!=='boolean'||r.independentCashVerified!==independentCashVerified))fail('FLAG');
 if(independentCashVerified)return {independentCashVerified:true,coveredScopeStatus:r.coveredScopeStatus};
 if(cashPolicy!=='allow-estimated-covered'||r.broker!=='schwab')fail('INDEPENDENT_REQUIRED');
 if(Object.hasOwn(r,'knownDifferenceCount')&&r.knownDifferenceCount!==0)fail('KNOWN_DIFFERENCE');
 if(r.coveredScopeStatus!=='COMPLETE'||r.valuationFinality!=='ESTIMATED'||!['LIMITED','UNKNOWN'].includes(r.nontradeCoverage?.kind)||r.nontradeCoverage.unresolvedKnownItems!==0)fail('ESTIMATED_SCOPE');
 if(!['authenticated-gmail-eligible-trades','authenticated-gmail-seven-day-partitioned-target-trades-and-notices'].includes(r.sourceScan?.sourceRangeKind))fail('NAMED_SOURCE_SCOPE');
 if(!c||c.matchStatus!=='NOT_INDEPENDENTLY_VERIFIED'||c.targetDate!==targetDate||JSON.stringify(c.currencyScope)!=='["USD"]')fail('DESTINATION_EVIDENCE');
 // Native provider form has no independent broker-cash timestamp. A fresh
 // authenticated completion and actual destination fingerprint carry the
 // source-read context, never an old cash confirmation relabelled as current.
 const nativeKeys=['targetDate','matchStatus','currencyScope','knownDifference','disclosure'];
 const readbackKeys=['targetDate','matchStatus','currencyScope','evidenceHash','destinationCapturedAt'];
 const keys=Object.keys(c).sort().join();
 if(keys===nativeKeys.sort().join()||keys===[...nativeKeys,'policy'].sort().join()){
  if(Object.hasOwn(c,'policy')&&c.policy!=='user-authorized-estimate-pending-independent-cash')fail('POLICY');
  if(c.knownDifference!==null)fail('KNOWN_DIFFERENCE');
  if(c.disclosure!==SCHWAB_CASH_DISCLOSURE)fail('DISCLOSURE');
 }else if(keys===readbackKeys.sort().join()){
  if(r.knownDifferenceCount!==0)fail('KNOWN_DIFFERENCE');
  if(r.cashDisclosure!==SCHWAB_CASH_DISCLOSURE)fail('DISCLOSURE');
  if(!hash(c.evidenceHash)||!time(c.destinationCapturedAt))fail('DESTINATION_EVIDENCE');
  const n=+new Date(now),t=Date.parse(c.destinationCapturedAt);
  if(!Number.isFinite(n)||!Number.isFinite(cashMaxAgeMs)||cashMaxAgeMs<=0||t>n||n-t>cashMaxAgeMs)fail('STALE');
 }else fail('DESTINATION_EVIDENCE');
 if(Object.hasOwn(r,'cashDisclosure')&&r.cashDisclosure!==SCHWAB_CASH_DISCLOSURE)fail('DISCLOSURE');
 return {independentCashVerified:false,coveredScopeStatus:'COMPLETE',coveredSourceScope:r.sourceScan.sourceRangeKind,cashReconciliation:'NOT_INDEPENDENTLY_VERIFIED'};
}
