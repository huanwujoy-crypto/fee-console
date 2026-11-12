// Connects the offline complete-original assembler to the existing intake.
//
//   request (ratio-offline-workbook-batch.v1)
//     -> scripts/fee-ratio-offline/cli.py   (fixed interpreter, isolated, empty env)
//     -> the assembler's actual original bytes + SHA-256
//     -> prepareCollectedRatioInput         (existing intake, unchanged)
//
// Default disabled: no process, no IO, no intake call. A converter refusal
// never reaches the intake. Success is PREPARED_UNAUTHENTICATED: it grants no
// provider authentication, Library identity for the new original, snapshot
// authorization or publication. No executable, module path, scope, verifier
// or authentication flag is accepted from the caller.
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareCollectedRatioInput} from './fee-ratio-source-collector.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';

export const OFFLINE_PYTHON='/usr/bin/python3';
export const OFFLINE_CLI=fileURLToPath(new URL('./fee-ratio-offline/cli.py',import.meta.url));
export const OFFLINE_ARGS=Object.freeze(['-I','-B',OFFLINE_CLI,'--enabled']);
const SCHEMA='fee-console.ratio-offline-assembly.v1';
const MAX_REQUEST=1024*1024,MAX_STDOUT=8*1024*1024,MAX_ORIGINAL=5*1024*1024;
const FALSE_FLAGS=['sourceOriginVerified','fullPerformanceReady','publicationReady','productionEnabled','currentCloudCompatibilityValidated'];
const CODES=new WeakMap();
const failure=code=>{const e=new Error('RATIO_OFFLINE_'+code);CODES.set(e,code);return e;};
export const ratioOfflineFailureCode=e=>'RATIO_OFFLINE_'+(CODES.get(e)||'REFUSED');
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;

function runAssembler(requestBytes,{timeoutMs,signal,spawnImpl}){
  return new Promise((resolve,reject)=>{
    let child,done=false,size=0;const chunks=[];
    const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);fn(value);};
    const kill=()=>{try{child?.kill('SIGKILL');}catch{}};
    const onAbort=()=>{kill();finish(reject,failure('CANCELLED'));};
    const timer=setTimeout(()=>{kill();finish(reject,failure('TIMEOUT'));},timeoutMs);
    if(signal?.aborted){onAbort();return;}
    signal?.addEventListener('abort',onAbort,{once:true});
    try{
      // Fixed interpreter and script, isolated mode, empty environment, no shell.
      child=spawnImpl(OFFLINE_PYTHON,[...OFFLINE_ARGS],{env:{},stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});
    }catch{finish(reject,failure('PROCESS'));return;}
    child.on('error',()=>finish(reject,failure('PROCESS')));
    child.stdout.on('data',d=>{size+=d.length;if(size>MAX_STDOUT){kill();finish(reject,failure('OUTPUT_SIZE'));}else chunks.push(d);});
    child.on('close',code=>finish(resolve,{code,stdout:Buffer.concat(chunks)}));
    child.stdin.on('error',()=>{});
    child.stdin.end(requestBytes);
  });
}

// Runs the actual assembler and returns its exact original bytes and digest.
export async function assembleOfflineOriginal({request,enabled=false,timeoutMs=120_000,signal,spawnImpl=spawn}={}){
  if(enabled===false)return {schema:SCHEMA,state:'DISABLED',publicationReady:false,productionEnabled:false};
  if(enabled!==true||!plain(request)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000
    ||signal!==undefined&&!(signal instanceof AbortSignal)||typeof spawnImpl!=='function')throw failure('INPUT');
  let requestBytes;
  try{requestBytes=Buffer.from(JSON.stringify(request));}catch{throw failure('INPUT');}
  if(requestBytes.length<2||requestBytes.length>MAX_REQUEST)throw failure('INPUT');
  const {code,stdout}=await runAssembler(requestBytes,{timeoutMs,signal,spawnImpl});
  let answer;
  try{answer=createLegacyPolicy().parseExactJson(stdout);}catch{throw failure('OUTPUT');}
  if(!plain(answer)||answer.schema!==SCHEMA)throw failure('OUTPUT');
  if(code!==0||answer.state!=='OFFLINE_COMPLETE_ORIGINAL_CANDIDATE'){
    const refused=answer.state==='REFUSED'&&typeof answer.code==='string'&&/^OFFLINE_[A-Z0-9_]{1,64}$/.test(answer.code);
    const e=failure('CONVERTER_REFUSED');e.converterCode=refused?answer.code:'OFFLINE_REFUSED';throw e;
  }
  if(FALSE_FLAGS.some(k=>answer[k]!==false)||answer.originalLibraryIdentityPending!==true||answer.uploads!==0||answer.publications!==0
    ||typeof answer.originalBase64!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(answer.originalBase64)
    ||typeof answer.originalSha256!=='string'||!/^[a-f0-9]{64}$/.test(answer.originalSha256))throw failure('RECEIPT');
  const originalBytes=Buffer.from(answer.originalBase64,'base64');
  if(originalBytes.toString('base64')!==answer.originalBase64||originalBytes.length!==answer.originalBytes
    ||originalBytes.length<1||originalBytes.length>MAX_ORIGINAL||sha256(originalBytes)!==answer.originalSha256)throw failure('RECEIPT');
  return {schema:SCHEMA,state:'OFFLINE_COMPLETE_ORIGINAL_CANDIDATE',originalBytes:new Uint8Array(originalBytes),
    originalSha256:answer.originalSha256,targetDate:answer.targetDate??null,codeReferenceBase:answer.codeReferenceBase??null,
    originalLibraryIdentityPending:true,blockedOn:Array.isArray(answer.blockedOn)?answer.blockedOn.filter(x=>typeof x==='string').slice(0,8):[],
    ...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false])),uploads:0,publications:0};
}

// Assembler output -> existing intake. `exposureCore` is the intake's own
// existing parameter (production default: the fixed repository scope).
export async function connectOfflineRatioInput({request,enabled=false,now=new Date(),exposureCore,timeoutMs,signal,spawnImpl,
  intakeImpl=prepareCollectedRatioInput}={}){
  if(enabled===false)return {schema:'fee-console.ratio-offline-connection.v1',status:'DISABLED',publicationReady:false,downloadVerified:false};
  if(typeof intakeImpl!=='function'||!(now instanceof Date)||!Number.isFinite(now.getTime()))throw failure('INPUT');
  const assembled=await assembleOfflineOriginal({request,enabled,...(timeoutMs===undefined?{}:{timeoutMs}),signal,...(spawnImpl===undefined?{}:{spawnImpl})});
  // Reached only with the assembler's own bytes and digest; never on refusal.
  const prepared=intakeImpl({originalBytes:assembled.originalBytes,expectedSha256:assembled.originalSha256,requirePerformance:true,now,
    ...(exposureCore===undefined?{}:{exposureCore})});
  if(prepared?.status!=='PREPARED_UNAUTHENTICATED'||prepared.publicationReady!==false||prepared.downloadVerified!==false
    ||prepared.sourceSha256!==assembled.originalSha256||prepared.performanceIncluded!==true)throw failure('INTAKE_CONTRACT');
  return {schema:'fee-console.ratio-offline-connection.v1',status:'PREPARED_UNAUTHENTICATED',publicationReady:false,downloadVerified:false,
    originalLibraryIdentityPending:true,prepared,
    converter:{state:assembled.state,targetDate:assembled.targetDate,codeReferenceBase:assembled.codeReferenceBase,blockedOn:assembled.blockedOn,
      ...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))}};
}
