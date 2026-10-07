// Anonymous fixed-public-byte acceptance after protected promotion; no credentials.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {assertFeePublicReadback} from './fee-publish-readback.mjs';
const BASE='https://huanwujoy-crypto.github.io/fee-console/';
export async function feePublicAcceptance({mainHealth,mainBytes,fetchImpl=fetch,attempts=8,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!Number.isInteger(attempts)||attempts<1||attempts>8)throw Error('FEE_PUBLIC_CONFIG');
 for(let i=0;i<attempts;i++){
  try{const bodies=await Promise.all(['fee-data-health.json','data.json'].map(async file=>{const r=await fetchImpl(BASE+file,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('FEE_PUBLIC_HTTP');const b=Buffer.from(await r.arrayBuffer());if(b.length>2097152)throw Error('FEE_PUBLIC_SIZE');return b;}));
   return assertFeePublicReadback({mainHealth,mainBytes,publicHealth:JSON.parse(bodies[0]),publicBytes:bodies[1],targetDate:mainHealth.targetDate});
  }catch{/* only fixed final state; no raw response, amounts or URL diagnostics */}
  if(i+1<attempts)await sleep(15000);
 }
 return {state:'PUBLIC_BYTES_PENDING',targetDate:mainHealth.targetDate};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2){console.error('FEE_PUBLIC_ARGUMENT');process.exitCode=1;}else{
 feePublicAcceptance({mainHealth:JSON.parse(fs.readFileSync(args[0])),mainBytes:fs.readFileSync(args[1])}).then(r=>{console.log(JSON.stringify(r));if(r.state!=='PUBLIC_BYTES_VERIFIED')process.exitCode=1;}).catch(()=>{console.error('FEE_PUBLIC_FAILED');process.exitCode=1;});
 }
}
