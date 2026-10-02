export function attemptFor(plan,time){
 if(!plan.windowEnabled||time<plan.startEpoch*1000||time>=plan.endEpoch*1000)throw new Error('ATTEMPT_OUTSIDE_WINDOW');
 return Math.min(2,Math.floor((time-plan.startEpoch*1000)/600000));
}
export function attemptPrefix(plan,attempt){
 if(!Number.isInteger(attempt)||attempt<0||attempt>2)throw new Error('ATTEMPT_INVALID');
 return `delivery/${plan.dataDate}/${plan.slotId}/`+(attempt?`retry-${attempt}/`:'');
}
