import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {createOwnerSdkTransport,OWNER_SDK_PYTHON,decodeOwnerSafeDiagnostics,OWNER_SAFE_DIAGNOSTIC_STAGES,OWNER_SAFE_ERROR_TYPES,OWNER_SAFE_ERROR_CODES} from './owner_sdk_transport.mjs';
import {LATEST_TARGET} from './owner_latest.mjs';
const execute=promisify(execFile),moduleUrl=new URL('./owner_sdk_transport.mjs',import.meta.url).href;
const latest=`https://storage.googleapis.com/storage/v1/b/${LATEST_TARGET.bucket}/o/${encodeURIComponent(LATEST_TARGET.object)}`;
const upload=`https://storage.googleapis.com/upload/storage/v1/b/${LATEST_TARGET.bucket}/o?uploadType=multipart&ifGenerationMatch=0`;
const rejected=async(code,fn)=>assert.rejects(fn,error=>error.safeCode===code);

const FIXED_SYNTHETIC_SDK_ROOT='/Users/huanwu/Documents/Codex/2026-07-13/chatgpt-conversation-6a36247f-db60-83e8-b9c6/.tools/google-cloud-sdk';
const diagnostic=(patch={})=>({schema:'xuan.owner-sdk.safe-diagnostics.v1',stage:'metadata-get',errorType:null,errorCode:null,causeCode:null,httpStatus:null,casHttpAttempts:0,casHttpAcks:0,readbackMetadataAttempts:0,readbackMetadataSuccesses:0,readbackHtmlAttempts:0,readbackHtmlSuccesses:0,...patch});
async function fakeWorker(action,body,{closeFails=false}={}){
 const saved={spawn:childProcess.spawn,realpath:fs.realpathSync,stat:fs.statSync,root:process.env.XUAN_OWNER_EXISTING_SDK_ROOT};
 process.env.XUAN_OWNER_EXISTING_SDK_ROOT=FIXED_SYNTHETIC_SDK_ROOT;fs.realpathSync=()=>FIXED_SYNTHETIC_SDK_ROOT;fs.statSync=()=>({isDirectory:()=>true});
 const pipe=()=>Object.assign(new EventEmitter(),{setEncoding(){},destroy(){if(closeFails)throw Error('SECRET_CLOSE');}});
 childProcess.spawn=()=>{const child=new EventEmitter();child.stdout=pipe();child.stderr=pipe();child.kill=()=>{if(closeFails)throw Error('SECRET_KILL');return true;};child.stdin={destroy(){if(closeFails)throw Error('SECRET_CLOSE');},write(line,callback){const frame=JSON.parse(line);queueMicrotask(()=>{const message=action(frame,child);child.stderr.emit('data','SECRET_LOG_TOKEN_URL_BODY');if(message)child.stdout.emit('data',JSON.stringify(message)+'\n');callback?.();});return true;}};return child;};syncBuiltinESMExports();
 const sdk=createOwnerSdkTransport();try{return await body(sdk);}finally{try{sdk.close();}catch(error){if(!closeFails)throw error;}childProcess.spawn=saved.spawn;fs.realpathSync=saved.realpath;fs.statSync=saved.stat;if(saved.root===undefined)delete process.env.XUAN_OWNER_EXISTING_SDK_ROOT;else process.env.XUAN_OWNER_EXISTING_SDK_ROOT=saved.root;syncBuiltinESMExports();}
}

test('construction and close are inert and permanently closed',async()=>{
  const sdk=createOwnerSdkTransport();sdk.close();sdk.close();
  await rejected('CLOSED',()=>sdk.checkOriginalIdentity());
});
test('daily named lane preserves strict paths, pins, methods and auth-header rejection before worker creation',async()=>{
  const sdk=createOwnerSdkTransport(),prefix=latest.slice(0,latest.lastIndexOf('/')+1);
  try{
    for(const name of ['delivery/2026-10-20/start.json','report-check/orders-probe-x/orders.json','other/receipt.json']){
      await assert.rejects(()=>sdk.requestDaily(prefix+encodeURIComponent(name),{headers:{Accept:'application/json','Accept-Encoding':'identity'}}));
    }
    const url=prefix+encodeURIComponent('delivery/2026-10-20/report.html');
    await rejected('HEADERS_INVALID',()=>sdk.requestDaily(url,{headers:{Accept:'application/json','Accept-Encoding':'identity',Authorization:'synthetic'}}));
    await assert.rejects(()=>sdk.requestDaily(url,{method:'DELETE'}));
    await rejected('REPLACEMENT_ADMISSION_EXPIRED',()=>sdk.requestDaily(upload.replace('=0','=1'),{method:'POST'}));
  }finally{sdk.close();}
});
test('daily read protocol uses its own named op without widening the original request method',async()=>{
  const url=latest.slice(0,latest.lastIndexOf('/')+1)+encodeURIComponent('delivery/2026-10-20/receipt.json');
  await fakeWorker(frame=>{
    assert.equal(frame.value.op,'dailyRequest');assert.equal(frame.value.url,url);
    return {id:frame.id,result:{status:200,url,headers:{'content-type':'application/json'},body:Buffer.from('{}').toString('base64')},
      safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]};
  },async sdk=>{
    await rejected('TARGET_INVALID',()=>sdk.request(url,{headers:{Accept:'application/json','Accept-Encoding':'identity'}}));
    assert.equal((await sdk.requestDaily(url,{headers:{Accept:'application/json','Accept-Encoding':'identity'}})).status,200);
  });
});

test('caller cannot widen storage origin/path/method or add auth headers',async()=>{
  const sdk=createOwnerSdkTransport();
  try{
    for(const url of [latest.replace('https:','http:'),latest.replace('storage.googleapis.com','evil.invalid'),latest.replace(LATEST_TARGET.bucket,'other'),latest.replace('owner-latest','other'),latest+'#x'])
      await rejected('TARGET_INVALID',()=>sdk.request(url,{headers:{Accept:'application/json','Accept-Encoding':'identity'}}));
    for(const method of ['PUT','DELETE','PATCH'])await rejected('REQUEST_INVALID',()=>sdk.request(latest,{method}));
    for(const name of ['Authorization','Cookie','Proxy-Authorization','Host','X-Goog-User-Project'])
      await rejected('HEADERS_INVALID',()=>sdk.request(latest,{headers:{Accept:'application/json','Accept-Encoding':'identity',[name]:'synthetic'}}));
  }finally{sdk.close();}
});

test('media requires one exact generation and duplicate queries fail',async()=>{
  const sdk=createOwnerSdkTransport();
  try{
    await rejected('PIN_REQUIRED',()=>sdk.request(latest+'?alt=media',{headers:{Accept:'application/octet-stream','Accept-Encoding':'identity'}}));
    await rejected('QUERY_INVALID',()=>sdk.request(latest+'?generation=1&generation=2',{headers:{Accept:'application/json','Accept-Encoding':'identity'}}));
    await rejected('REQUEST_INVALID',()=>sdk.request(latest,{redirect:'follow'}));
  }finally{sdk.close();}
});

test('latest writes have fixed CAS0 multipart and canary has no arbitrary payload capability',async()=>{
  const sdk=createOwnerSdkTransport();
  try{
    await rejected('TARGET_INVALID',()=>sdk.request(upload.replace('ifGenerationMatch=0','ifGenerationMatch=1'),{method:'POST',headers:{Accept:'application/json','Content-Type':'multipart/related; boundary=xuan_owner_latest_'+'a'.repeat(64)},body:new Uint8Array([1])}));
    for(const encoding of ['gzip','identity, gzip','*','IDENTITY'])await rejected('HEADERS_INVALID',()=>sdk.request(upload,{method:'POST',headers:{Accept:'application/json','Content-Type':'multipart/related; boundary=xuan_owner_latest_'+'a'.repeat(64),'Accept-Encoding':encoding},body:new Uint8Array([1])}));
    await rejected('CANARY_INVALID',()=>sdk.createCanary({uuid:'invalid',createdAt:new Date().toISOString(),candidateSha256:'a'.repeat(64)}));
    await rejected('CANARY_REQUEST_INVALID',()=>sdk.requestCanary({method:'GET',media:true}));
    await rejected('CANARY_REQUEST_INVALID',()=>sdk.requestCanary({method:'HEAD',generation:'1'}));
  }finally{sdk.close();}
});
test('named replacement cannot mint a grant from caller flags, missing pins or CAS0',async()=>{
  const sdk=createOwnerSdkTransport();
  try{for(const pins of [undefined,{approved:true},{revisionSha256:'a'.repeat(64),previousGeneration:'0',previousDisplaySha256:'b'.repeat(64),previousRegistrationSha256:'c'.repeat(64)},
    {revisionSha256:'a'.repeat(64),previousGeneration:'1',previousDisplaySha256:'b'.repeat(64),previousRegistrationSha256:'c'.repeat(64),approved:true}])
    await rejected('REPLACEMENT_INVALID',()=>sdk.requestPreviewReplacement(upload,{method:'POST'},pins,{admissionExpiresAt:Date.now()+5000}));
  }finally{sdk.close();}
});

test('Node IPC fixes financial POST identity and typed canary cannot supply negotiation headers',async t=>{
  const originalSpawn=childProcess.spawn,frames=[],previousRoot=process.env.XUAN_OWNER_EXISTING_SDK_ROOT,originalRealpath=fs.realpathSync,originalStat=fs.statSync;
  process.env.XUAN_OWNER_EXISTING_SDK_ROOT=FIXED_SYNTHETIC_SDK_ROOT;fs.realpathSync=()=>FIXED_SYNTHETIC_SDK_ROOT;fs.statSync=()=>({isDirectory:()=>true});
  const pipe=()=>Object.assign(new EventEmitter(),{setEncoding(){},destroy(){}});
  childProcess.spawn=()=>{
    const child=new EventEmitter();child.stdout=pipe();child.stderr=pipe();
    child.stdin={destroy(){},write(line,callback){const frame=JSON.parse(line);frames.push(frame);
      queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({id:frame.id,error:'READ_FAILED',safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]})+'\n');callback?.();});return true;}};
    child.kill=()=>true;return child;
  };syncBuiltinESMExports();
  const sdk=createOwnerSdkTransport();
  try{
    await rejected('READ_FAILED',()=>sdk.request(upload,{method:'POST',headers:{Accept:'application/json','Content-Type':'multipart/related; boundary=xuan_owner_latest_'+'a'.repeat(64)},body:new Uint8Array([1])}));
    const fields={uuid:'00000000-0000-4000-8000-000000000000',createdAt:new Date().toISOString(),candidateSha256:'a'.repeat(64)};
    await rejected('CANARY_INVALID',()=>sdk.createCanary({...fields,headers:{'Accept-Encoding':'gzip'}}));
    await rejected('READ_FAILED',()=>sdk.createCanary(fields));
    assert.equal(frames.length,2);
    assert.equal(frames[0].value.op,'request');assert.equal(frames[0].value.method,'POST');
    assert.deepEqual(Object.keys(frames[0].value.headers).sort(),['accept','accept-encoding','content-type']);
    assert.equal(frames[0].value.headers['accept-encoding'],'identity');
    assert.deepEqual(frames[1].value,{op:'createCanary',...fields}); // worker alone reconstructs fixed identity headers
  }finally{sdk.close();childProcess.spawn=originalSpawn;fs.realpathSync=originalRealpath;fs.statSync=originalStat;if(previousRoot===undefined)delete process.env.XUAN_OWNER_EXISTING_SDK_ROOT;else process.env.XUAN_OWNER_EXISTING_SDK_ROOT=previousRoot;syncBuiltinESMExports();}
});

test('abort closes bridge before any worker/credential operation',async()=>{
  const sdk=createOwnerSdkTransport(),controller=new AbortController();controller.abort();
  await rejected('ABORTED',()=>sdk.checkOriginalIdentity({signal:controller.signal}));
  await rejected('CLOSED',()=>sdk.checkOriginalIdentity());
});

test('worker malformed multipart is rejected before SDK credential import; no replay',async()=>{
  // A separate process keeps this test isolated from concurrent test env. The
  // malformed body is rejected by the pure worker validator before SDK use.
  const env={...process.env};for(const k of Object.keys(env))if(/^(?:CLOUDSDK_|GOOGLE_|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|SSL_CERT_|(?:https?|all)_proxy)/i.test(k))delete env[k];
  const code=`import {createOwnerSdkTransport} from ${JSON.stringify(moduleUrl)};
const sdk=createOwnerSdkTransport();try{const args={method:'POST',headers:{Accept:'application/json','Content-Type':'multipart/related; boundary=xuan_owner_latest_'+'a'.repeat(64)},body:new Uint8Array([1,2,3])};
for(let i=0;i<2;i++){try{await sdk.request(${JSON.stringify(upload)},args);process.stdout.write('UNEXPECTED\\n');}catch(e){process.stdout.write(e.safeCode+'\\n');}}}finally{sdk.close();}`;
  if(!existsSync(OWNER_SDK_PYTHON)||!process.env.XUAN_OWNER_EXISTING_SDK_ROOT)return; // Mac bridge also needs the exact approved runtime locator.
  const {stdout,stderr}=await execute(process.execPath,['--input-type=module','-e',code],{env,timeout:15000,maxBuffer:2048});
  assert.equal(stderr,'');assert.equal(stdout,'MULTIPART_INVALID\nWRITE_ALREADY_ATTEMPTED\n');
});

test('Python boundary and official-library synthetic regressions are in cloud test entry',async()=>{
  const python=existsSync(OWNER_SDK_PYTHON)?OWNER_SDK_PYTHON:'python3';
  const path=fileURLToPath(new URL('./owner_sdk_transport.test.py',import.meta.url));
  const {stdout,stderr}=await execute(python,['-I','-B',path],{timeout:30000,maxBuffer:32768});
  assert.equal(stdout,'');assert.match(stderr,/\bOK\b/);
});

test('production source excludes credential CLI, auth HTTP, unsafe retries or dynamic worker paths',()=>{
  const source=readFileSync(new URL('./owner_sdk_transport.py',import.meta.url),'utf8');
  assert.match(source,/max_refresh_attempts=0/);assert.match(source,/auth_request=reject_auth_request/);
  assert.match(source,/HTTPAdapter\(max_retries=0\)/);assert.match(source,/allow_redirects=False, stream=True/);
  assert.match(source,/GetCredentialStore\(\)\.Load\(self.account\)/);
  assert.doesNotMatch(source,/LoadIfEnabled\(|STATIC_CREDENTIAL_PROVIDERS|subprocess|Keychain|keyring|print\(/);
  assert.doesNotMatch(source,/chatgpt-conversation-/);
});

test('missing or different SDK locator cannot select another runtime',async()=>{
  const env={...process.env};for(const k of Object.keys(env))if(/^(?:CLOUDSDK_|GOOGLE_|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|SSL_CERT_|(?:https?|all)_proxy|XUAN_OWNER_EXISTING_SDK_ROOT)/i.test(k))delete env[k];
  const code=`import {createOwnerSdkTransport} from ${JSON.stringify(moduleUrl)};const sdk=createOwnerSdkTransport();try{await sdk.checkOriginalIdentity();process.stdout.write('UNEXPECTED');}catch(e){process.stdout.write(e.safeCode);}finally{sdk.close();}`;
  for(const [value,expected] of [[undefined,'SDK_ROOT_REQUIRED'],['/tmp','SDK_ROOT_INVALID']]){
    const {stdout,stderr}=await execute(process.execPath,['--input-type=module','-e',code],{env:{...env,...(value?{XUAN_OWNER_EXISTING_SDK_ROOT:value}:{})},timeout:10000,maxBuffer:1024});
    assert.equal(stderr,'');assert.equal(stdout,expected);
  }
});


test('safe SDK diagnostic codec is exact, bounded, frozen and does not invoke getters/proxies',()=>{
 const value=diagnostic({stage:'cas',casHttpAttempts:1,casHttpAcks:1,httpStatus:200});const decoded=decodeOwnerSafeDiagnostics(value);assert.deepEqual(decoded,value);assert(Object.isFrozen(decoded));
 for(const patch of [{stage:'PRIVATE_URL'},{errorType:'SECRET'},{errorCode:'SECRET'},{causeCode:'SECRET'},{httpStatus:true},{httpStatus:600},{casHttpAttempts:2},{casHttpAcks:1,casHttpAttempts:0},{readbackHtmlSuccesses:1,readbackHtmlAttempts:0},{casHttpAttempts:NaN}])assert.equal(decodeOwnerSafeDiagnostics(diagnostic(patch)),null);
 let traps=0;const proxy=new Proxy(value,{getPrototypeOf(){traps++;throw Error('SECRET');},ownKeys(){traps++;throw Error('SECRET');},get(){traps++;throw Error('SECRET');}});assert.equal(decodeOwnerSafeDiagnostics(proxy),null);assert.equal(traps,0);
 const getter={...value};Object.defineProperty(getter,'stage',{get(){traps++;throw Error('SECRET');},enumerable:true});assert.equal(decodeOwnerSafeDiagnostics(getter),null);assert.equal(traps,0);
 assert.equal(new Set(OWNER_SAFE_DIAGNOSTIC_STAGES).size,13);assert.equal(new Set(OWNER_SAFE_ERROR_TYPES).size,28);assert.equal(new Set(OWNER_SAFE_ERROR_CODES).size,67);
});
test('validated diagnostics attach frozen and nonenumerable to original JSON result and native Response',async()=>{
 await fakeWorker(frame=>({id:frame.id,result:frame.value.op==='identity'?{schema:'synthetic.identity'}:{status:200,url:frame.value.url,headers:{'content-type':'application/json'},body:'e30='},safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]}),async sdk=>{
  const result=await sdk.checkOriginalIdentity();assert.deepEqual(Object.keys(result),['schema']);assert.equal(JSON.stringify(result),' {"schema":"synthetic.identity"}'.trim());assert(Object.isFrozen(result.ownerSafeDiagnostics));assert.equal(Object.getOwnPropertyDescriptor(result,'ownerSafeDiagnostics').enumerable,false);
  const response=await sdk.request(latest,{headers:{Accept:'application/json','Accept-Encoding':'identity'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{});assert.equal(response.ownerSafeDiagnostics.schema,'xuan.owner-sdk.safe-diagnostics.v1');assert(Object.isFrozen(response.ownerSafeCleanupDiagnostics));assert.equal(Object.keys(response).includes('ownerSafeDiagnostics'),false);
 });
});
test('error diagnostics preserve finite primary and independent close failure without raw stderr',async()=>{
 const d=diagnostic({stage:'cas',errorType:'ConnectionResetError',errorCode:'ECONNRESET',casHttpAttempts:1});const cleanup={...d,stage:'close',errorType:'BrokenPipeError',errorCode:'EPIPE'};
 await fakeWorker(frame=>({id:frame.id,error:'REQUEST_OUTCOME_UNKNOWN',safeDiagnostics:d,safeCleanupDiagnostics:[cleanup]}),async sdk=>{await assert.rejects(sdk.checkOriginalIdentity(),error=>{assert.equal(error.safeCode,'REQUEST_OUTCOME_UNKNOWN');assert.deepEqual(error.ownerSafeDiagnostics,d);assert.deepEqual(error.ownerSafeCleanupDiagnostics,[cleanup]);assert(!JSON.stringify(error).includes('SECRET'));return true;});});
});
test('malformed/missing diagnostic or arbitrary uppercase RPC error is rejected as unknown, never zero',async()=>{
 for(const patch of [{safeDiagnostics:undefined},{safeDiagnostics:diagnostic({casHttpAttempts:2})},{error:'SECRET_ACCESS_TOKEN'},{safeCleanupDiagnostics:[diagnostic()]},{safeCleanupDiagnostics:[diagnostic({stage:'close'}),diagnostic({stage:'close'})]}])await fakeWorker(frame=>({id:frame.id,error:'READ_FAILED',safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[],...patch}),async sdk=>{await assert.rejects(sdk.checkOriginalIdentity(),error=>error.safeCode==='FRAME_INVALID'&&error.ownerSafeDiagnostics===null);});
});
test('result cannot smuggle reserved diagnostic keys past response shape checks',async()=>{
 await fakeWorker(frame=>({id:frame.id,result:{status:200,url:latest,headers:{},body:'',ownerSafeDiagnostics:'SECRET'},safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]}),async sdk=>{await assert.rejects(sdk.checkOriginalIdentity(),error=>error.safeCode==='FRAME_INVALID'&&error.ownerSafeDiagnostics===null);});
});
test('cumulative HTTP evidence cannot decrease across RPC frames',async()=>{
 let call=0;await fakeWorker(frame=>({id:frame.id,result:{schema:'synthetic'},safeDiagnostics:diagnostic(call++?{}:{casHttpAttempts:1,casHttpAcks:1}),safeCleanupDiagnostics:[]}),async sdk=>{assert.equal((await sdk.checkOriginalIdentity()).ownerSafeDiagnostics.casHttpAcks,1);await assert.rejects(sdk.checkOriginalIdentity(),error=>error.safeCode==='FRAME_INVALID'&&error.ownerSafeDiagnostics===null);});
});

test('explicit local close failure throws finite code and does not invent HTTP evidence',async()=>{
 await fakeWorker(frame=>({id:frame.id,result:{schema:'synthetic'},safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]}),async sdk=>{await sdk.checkOriginalIdentity();assert.throws(()=>sdk.close(),error=>error.safeCode==='SDK_LOCAL_CLOSE_FAILED'&&error.ownerSafeDiagnostics===null&&error.ownerSafeLocalCleanupCodes[0]==='SDK_LOCAL_CLOSE_FAILED');},{closeFails:true});
});
test('internal close failure never replaces the pending protocol primary',async()=>{
 await fakeWorker(frame=>({id:frame.id,error:'SECRET_NOT_ALLOWLISTED',safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]}),async sdk=>{await assert.rejects(sdk.checkOriginalIdentity(),error=>error.safeCode==='FRAME_INVALID'&&error.ownerSafeDiagnostics===null&&error.ownerSafeLocalCleanupCodes[0]==='SDK_LOCAL_CLOSE_FAILED');},{closeFails:true});
});
test('child lost without a diagnostic frame remains unknown and local cleanup stays secondary',async()=>{
 await fakeWorker((_frame,child)=>{child.emit('exit',1);return null;},async sdk=>{await assert.rejects(sdk.checkOriginalIdentity(),error=>error.safeCode==='WORKER_CLOSED'&&error.ownerSafeDiagnostics===null&&error.ownerSafeLocalCleanupCodes[0]==='SDK_LOCAL_CLOSE_FAILED');},{closeFails:true});
});

test('pre-aborted next RPC retains ABORTED primary and previously observed local cleanup failures',async()=>{
 let calls=0;await fakeWorker(frame=>{calls++;return {id:frame.id,result:{schema:'synthetic'},safeDiagnostics:diagnostic(),safeCleanupDiagnostics:[]};},async sdk=>{
  await sdk.checkOriginalIdentity();const controller=new AbortController();controller.abort();
  await assert.rejects(sdk.checkOriginalIdentity({signal:controller.signal}),error=>error.safeCode==='ABORTED'&&error.ownerSafeDiagnostics===null&&error.ownerSafeLocalCleanupCodes.length===1&&error.ownerSafeLocalCleanupCodes[0]==='SDK_LOCAL_CLOSE_FAILED');
  assert.equal(calls,1);
 },{closeFails:true});
});
