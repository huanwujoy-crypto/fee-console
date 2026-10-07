// Public byte guard is wired by the proposed promoter CLI; early completion guard remains disabled.
import crypto from 'node:crypto';
import {validateHealth} from './fee-data-health.mjs';
import {checkOnly} from './fee-completion-runtime.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export async function assertCompletionBeforePromotion({health,dataBytes,key,read,readDestination,candidateSha,expectedTargetDate,now=new Date(),env={}}={}){
 if(env.FEE_BROKER_COMPLETENESS_ENABLED!=='true')throw Error('FEE_PUBLISH_COMPLETION_DISABLED');
 const baseKeys=['schema','checkedAt','targetDate','sourceDates','outcome','dataSha256','errorCode'];
 if(!health||Object.keys(health).some(k=>![...baseKeys,'brokerSyncBinding','brokerCashDisclosure','tradeLinkBinding'].includes(k)))throw Error('FEE_PUBLISH_HEALTH_SHAPE');
 const base=Object.fromEntries(baseKeys.map(k=>[k,health[k]]));
 if(validateHealth(base,{now}).length||!Buffer.isBuffer(dataBytes)||sha(dataBytes)!==health.dataSha256||health.targetDate!==expectedTargetDate||!/^([a-f0-9]{40})$/.test(candidateSha||''))throw Error('FEE_PUBLISH_CANDIDATE_BINDING');
 return checkOnly({env,read,readDestination,health,key,now,request:{candidateSha,dataSha256:health.dataSha256,targetDate:health.targetDate,nonce:crypto.randomBytes(16).toString('hex')}});
}
export function assertFeePublicReadback({mainHealth,publicHealth,mainBytes,publicBytes,targetDate,benchmarkRequired=false}={}){
 if(!Buffer.isBuffer(mainBytes)||!Buffer.isBuffer(publicBytes)||JSON.stringify(mainHealth)!==JSON.stringify(publicHealth)||mainHealth?.targetDate!==targetDate||sha(mainBytes)!==mainHealth.dataSha256||sha(publicBytes)!==mainHealth.dataSha256||!['updated','no-op'].includes(mainHealth.outcome)||mainHealth.sourceDates?.schwab!==targetDate||mainHealth.sourceDates?.webull!==targetDate||benchmarkRequired&&mainHealth.sourceDates?.benchmark!==targetDate)throw Error('FEE_PUBLISH_PUBLIC_MISMATCH');
 return {state:'PUBLIC_BYTES_VERIFIED',targetDate,benchmarkState:mainHealth.sourceDates.benchmark===targetDate?'session':'pending',dataSha256:mainHealth.dataSha256};
}
