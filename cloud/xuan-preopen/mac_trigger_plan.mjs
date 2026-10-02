// Offline plan for an independent Mac watchdog. It does not run gh, install a
// launch agent, wake a Mac, grant permissions or trigger workflows.
import {planPreopen} from './calendar.mjs';import {attemptFor} from './attempts.mjs';
export function planIndependentTrigger({now,runs=[],claimedSlots=[]}){
 const plan=planPreopen(now);if(!plan.windowEnabled)return{action:'none',reason:'outside-regular-window'};
 const bucket=attemptFor(plan,now),key=plan.slotId+':'+bucket;
 const current=runs.filter(r=>r.workflow==='xuan-preopen-cloud-producer.yml'&&r.branch==='main'&&Date.parse(r.createdAt)>=plan.startEpoch*1000&&Date.parse(r.createdAt)<=now);
 if(current.some(r=>r.status!=='completed'))return{action:'follow-existing',slotId:plan.slotId};
 if(current.some(r=>r.status==='completed'&&r.conclusion==='success'))return{action:'verify-public-result',slotId:plan.slotId,formalSuccess:false};
 if(claimedSlots.includes(key))return{action:'none',reason:'local-attempt-already-claimed'};
 return{action:'dispatch-fixed-workflow',workflow:'xuan-preopen-cloud-producer.yml',ref:'main',attempt:bucket,claimKey:key,slotId:plan.slotId,formalSuccess:false};
}
