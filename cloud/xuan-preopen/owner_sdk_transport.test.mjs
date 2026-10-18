import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {createOwnerSdkTransport,OWNER_SDK_PYTHON} from './owner_sdk_transport.mjs';
import {LATEST_TARGET} from './owner_latest.mjs';
const execute=promisify(execFile),moduleUrl=new URL('./owner_sdk_transport.mjs',import.meta.url).href;
const latest=`https://storage.googleapis.com/storage/v1/b/${LATEST_TARGET.bucket}/o/${encodeURIComponent(LATEST_TARGET.object)}`;
const upload=`https://storage.googleapis.com/upload/storage/v1/b/${LATEST_TARGET.bucket}/o?uploadType=multipart&ifGenerationMatch=0`;
const rejected=async(code,fn)=>assert.rejects(fn,error=>error.safeCode===code);

test('construction and close are inert and permanently closed',async()=>{
  const sdk=createOwnerSdkTransport();sdk.close();sdk.close();
  await rejected('CLOSED',()=>sdk.checkOriginalIdentity());
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
  if(!process.env.XUAN_OWNER_EXISTING_SDK_ROOT){t.skip('Exact Mac runtime locator absent');return;}
  const originalSpawn=childProcess.spawn,frames=[];
  const pipe=()=>Object.assign(new EventEmitter(),{setEncoding(){},destroy(){}});
  childProcess.spawn=()=>{
    const child=new EventEmitter();child.stdout=pipe();child.stderr=pipe();
    child.stdin={destroy(){},write(line,callback){const frame=JSON.parse(line);frames.push(frame);
      queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({id:frame.id,error:'SYNTHETIC_STOP'})+'\n');callback?.();});return true;}};
    child.kill=()=>true;return child;
  };syncBuiltinESMExports();
  const sdk=createOwnerSdkTransport();
  try{
    await rejected('SYNTHETIC_STOP',()=>sdk.request(upload,{method:'POST',headers:{Accept:'application/json','Content-Type':'multipart/related; boundary=xuan_owner_latest_'+'a'.repeat(64)},body:new Uint8Array([1])}));
    const fields={uuid:'00000000-0000-4000-8000-000000000000',createdAt:new Date().toISOString(),candidateSha256:'a'.repeat(64)};
    await rejected('CANARY_INVALID',()=>sdk.createCanary({...fields,headers:{'Accept-Encoding':'gzip'}}));
    await rejected('SYNTHETIC_STOP',()=>sdk.createCanary(fields));
    assert.equal(frames.length,2);
    assert.equal(frames[0].value.op,'request');assert.equal(frames[0].value.method,'POST');
    assert.deepEqual(Object.keys(frames[0].value.headers).sort(),['accept','accept-encoding','content-type']);
    assert.equal(frames[0].value.headers['accept-encoding'],'identity');
    assert.deepEqual(frames[1].value,{op:'createCanary',...fields}); // worker alone reconstructs fixed identity headers
  }finally{sdk.close();childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
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
