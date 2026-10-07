import {assertCashDisclosure} from './fee-completion-disclosure.mjs';
import {completionConfig,readCompletionPair,recheckCompletion} from './fee-completion-transport.mjs';
import {sealBinding,openBinding} from './fee-completion-binding.mjs';
import {assertSameBinding} from './fee-completion-policy.mjs';
// Production integrations must supply the actual stable Sharesight snapshot
// adapter; no local receipt or boolean can substitute for its readback.
export async function prepareBinding({env=process.env,read,readDestination,targetDate,dataSha256,key,now=new Date()}){
 const config=completionConfig(env);if(!config.enabled)return undefined;
 if(typeof readDestination!=='function')throw Error('FEE_COMPLETION_DESTINATION_ADAPTER');
 const options={read,targetDate,now,...config},before=await readCompletionPair(options);
 const current=await readDestination(targetDate);
 for(const b of before)if(current[b.broker]!==b.destinationFingerprint)throw Error('FEE_COMPLETION_DESTINATION_CHANGED');
 await recheckCompletion({...options,now:new Date(now)},before);
 return sealBinding(before,{targetDate,dataSha256},key);
}
export async function checkOnly({env=process.env,read,readDestination,health,key,request,now=new Date()}){
 const config=completionConfig(env);if(!config.enabled)throw Error('FEE_COMPLETION_DISABLED');
 if(health.targetDate!==request.targetDate||health.dataSha256!==request.dataSha256)throw Error('FEE_COMPLETION_REQUEST_BINDING');
 const before=openBinding(health.brokerSyncBinding,health,key);
 const current=await readCompletionPair({read,targetDate:health.targetDate,now,...config});assertSameBinding(before,current);assertCashDisclosure(health,current);
 if(typeof readDestination!=='function')throw Error('FEE_COMPLETION_DESTINATION_ADAPTER');
 const destination=await readDestination(health.targetDate);
 for(const b of current)if(destination[b.broker]!==b.destinationFingerprint)throw Error('FEE_COMPLETION_DESTINATION_CHANGED');
 await recheckCompletion({read,targetDate:health.targetDate,now,...config},current);
 return {schema:'fee.completion-recheck.v1',state:'VERIFIED',candidateSha:request.candidateSha,dataSha256:request.dataSha256,targetDate:request.targetDate,nonce:request.nonce,checkedAt:new Date(now).toISOString()};
}
