import {cashPolicyConfig} from './fee-completion-cash-policy.mjs';
import {validateCompletion,assertSameBinding,sha256} from './fee-completion-policy.mjs';
const buckets=Object.freeze({schwab:'family-portfolio-gateway-schwab-gmail-state-860729177589',webull:'family-portfolio-gateway-webull-gmail-state-860729177589'});
const fail=()=>{throw Error('FEE_COMPLETION_TRANSPORT');};
const generation=x=>typeof x==='string'&&/^[1-9][0-9]*$/.test(x);
export const completionConfig=env=>({enabled:env.FEE_BROKER_COMPLETENESS_ENABLED==='true',receiptMaxAgeMs:3600000,cashMaxAgeMs:3600000,cashPolicy:cashPolicyConfig(env)});
// Access token stays in this closure. No dynamic bucket, endpoint or redirect.
export function gcsReceiptReader({token,fetchImpl=fetch}){
 if(typeof token!=='string'||!token)fail();
 return async(broker,key,expectedGeneration)=>{
  if(!Object.hasOwn(buckets,broker)||!/^fee-completion\/v2\/(schwab|webull)\/\d{4}-\d{2}-\d{2}\/(current\.json|receipts\/[a-f0-9]{64}\.json)$/.test(key)||!key.startsWith(`fee-completion/v2/${broker}/`))fail();
  const endpoint=`https://storage.googleapis.com/storage/v1/b/${buckets[broker]}/o/${encodeURIComponent(key)}`;
  const get=async url=>{const r=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)fail();const b=Buffer.from(await r.arrayBuffer());if(b.length>524288)fail();return b;};
  const meta=JSON.parse((await get(endpoint)).toString('utf8'));
  if(meta.bucket!==buckets[broker]||meta.name!==key||!generation(meta.generation)||(expectedGeneration&&meta.generation!==expectedGeneration))fail();
  const raw=await get(`${endpoint}?alt=media&generation=${meta.generation}&ifGenerationMatch=${meta.generation}`);
  return {generation:meta.generation,raw,value:JSON.parse(raw.toString('utf8'))};
 };
}
export async function readCompletionPair({read,targetDate,now=new Date(),receiptMaxAgeMs,cashMaxAgeMs,cashPolicy='require-independent'}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate))fail();
 const bindings=[];
 for(const broker of ['schwab','webull']){
  const key=`fee-completion/v2/${broker}/${targetDate}/current.json`,p=await read(broker,key),v=p.value;
  const prefix=`fee-completion/v2/${broker}/${targetDate}/receipts/`;
  if(v?.schema!=='fee.broker-completion-pointer.v2'||v.broker!==broker||v.targetDate!==targetDate||v.state!=='COMPLETE'||!generation(v.receiptGeneration)||!/^([a-f0-9]{64})$/.test(v.receiptHash)||v.receiptRef!==`${prefix}${v.receiptHash}.json`)fail();
  const r=await read(broker,v.receiptRef,v.receiptGeneration);
  if(sha256(r.raw)!==v.receiptHash||r.value.destinationFingerprint!==v.destinationFingerprint)fail();
  // Provider identity originates from the fixed bucket trust boundary, never JSON issuer.
  const coverage=validateCompletion(r.value,{targetDate,now,receiptMaxAgeMs,cashMaxAgeMs,cashPolicy,authenticatedProvider:`${broker}-gmail-sync-runtime@family-portfolio-gateway.iam.gserviceaccount.com`});
  bindings.push({broker,coveredScopeStatus:coverage.coveredScopeStatus,independentCashVerified:coverage.independentCashVerified,receiptHash:v.receiptHash,receiptGeneration:r.generation,pointerGeneration:p.generation,destinationFingerprint:v.destinationFingerprint});
 }
 for(const b of bindings){const p=await read(b.broker,`fee-completion/v2/${b.broker}/${targetDate}/current.json`);if(p.generation!==b.pointerGeneration||p.value.state!=='COMPLETE')fail();}
 return bindings;
}
export async function recheckCompletion(options,before){const after=await readCompletionPair(options);assertSameBinding(before,after);return after;}
