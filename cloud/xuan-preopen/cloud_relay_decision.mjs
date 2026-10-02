// Pure independent cloud timer policy; no HTTP server, token read or dispatch.
// A trusted collector supplies verified GitHub/public facts, not request bodies.
import {planPreopen} from './calendar.mjs';import {attemptFor} from './attempts.mjs';
export const RELAY_DISPATCH_TARGET=Object.freeze({repository:'huanwujoy-crypto/fee-console',workflow:'xuan-preopen-cloud-producer.yml',ref:'main'});
export function decideCloudRelay({now,mainConfigured=false,publicProof=false,runs=[],claims=[]}){
 const plan=planPreopen(now);if(!plan.windowEnabled)return{action:'none',reason:'OUTSIDE_REGULAR_WINDOW'};
 if(!mainConfigured)return{action:'blocked',reason:'FORMAL_SOURCE_ADAPTER_NOT_CONFIGURED'};
 if(publicProof===true)return{action:'done',reason:'FORMAL_PUBLIC_PROOF_VERIFIED'};
 const bucket=attemptFor(plan,now),key=`state/${plan.slotId}/attempt-${bucket}.json`;
 const current=runs.filter(r=>r.workflow===RELAY_DISPATCH_TARGET.workflow&&r.branch==='main'&&Number.isFinite(Date.parse(r.createdAt))&&Date.parse(r.createdAt)>=plan.startEpoch*1000&&Date.parse(r.createdAt)<=now);
 if(current.some(r=>r.status!=='completed'))return{action:'follow',reason:'PRODUCER_ACTIVE'};
 if(current.some(r=>r.status==='completed'&&r.conclusion==='success'))return{action:'follow',reason:'SUCCESS_REQUIRES_PUBLIC_PROOF'};
 // Any accepted/uncertain POST is irreversible until the collector verifies a
 // matching run completed unsuccessfully. No absence-of-run timeout guesses.
 if(claims.some(c=>c.slotId===plan.slotId&&c.failedRunVerified!==true))return{action:'follow',reason:'DISPATCH_ACCEPTED_OR_UNCERTAIN'};
 if(claims.some(c=>c.key===key))return{action:'none',reason:'ATTEMPT_ALREADY_CLAIMED'};
 return{action:'claim-then-dispatch',claimKey:key,attempt:bucket,slotId:plan.slotId,sourceDate:plan.sourceDate,target:RELAY_DISPATCH_TARGET,payload:{ref:'main'},formalSuccess:false};
}
export async function executeRelayDecision(input,{createClaim,recheck,postDispatch,saveResult}){
 const plan=decideCloudRelay(input);if(plan.action!=='claim-then-dispatch')return plan;
 // Adapter must implement GCS insert ifGenerationMatch=0. Race loser cannot
 // dispatch. Immutable result objects never delete/overwrite the claim.
 if(!await createClaim(plan.claimKey,{slotId:plan.slotId,attempt:plan.attempt,createdAt:new Date(input.now).toISOString()}))return{action:'follow',reason:'CLAIM_ALREADY_EXISTS'};
 const facts=await recheck();
 const checked=decideCloudRelay({...facts,claims:(facts.claims||[]).filter(c=>c.key!==plan.claimKey)});
 if(checked.action!=='claim-then-dispatch'||checked.claimKey!==plan.claimKey){await saveResult(plan.claimKey,{outcome:'suppressed'});return{action:'follow',reason:'STATE_CHANGED_AFTER_CLAIM'};}
 try{const status=await postDispatch(RELAY_DISPATCH_TARGET,{ref:'main'});const outcome=status===204?'accepted':'uncertain';await saveResult(plan.claimKey,{outcome});return{action:'follow',reason:outcome==='accepted'?'DISPATCH_ACCEPTED':'DISPATCH_UNCERTAIN'};}
 catch{await saveResult(plan.claimKey,{outcome:'uncertain'});return{action:'follow',reason:'DISPATCH_UNCERTAIN'};}
}
