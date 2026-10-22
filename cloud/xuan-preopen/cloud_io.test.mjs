import test from 'node:test';
import assert from 'node:assert/strict';
import {createIbCredentialLease,isIbCredentialLockRequest,IB_CREDENTIAL_LOCK_KEY,boundedText, privateCloudIo,uniqueCloudJson,validateIbCredentialBinding,validateBoundIbVersionName,
  attachOwnerReadDiagnostics,safeOwnerReadDiagnostics,createOwnerFailureEvidence,safeOwnerFailureEvidence,ownerReadRequestClass} from './cloud_io.mjs';


// Synthetic fixed-object CAS transport; never falls back to actual fetch.
function lockTransport(baseFetch){
  let record=null,generation=0;
  return async(url,options={})=>{
    if(!isIbCredentialLockRequest(url,options))return baseFetch(url,options);
    const u=new URL(url),meta=()=>({name:IB_CREDENTIAL_LOCK_KEY,generation:String(generation),size:String(Buffer.byteLength(JSON.stringify(record)))});
    if((options.method??'GET')==='GET'){
      if(record===null)return Response.json({}, {status:404});
      if(u.searchParams.get('alt')==='media')return u.searchParams.get('generation')===String(generation)?Response.json(record):Response.json({}, {status:412});
      return Response.json(meta());
    }
    if(u.searchParams.get('ifGenerationMatch')!==String(generation))return Response.json({}, {status:412});
    record=JSON.parse(options.body.toString());generation++;return Response.json(meta());
  };
}

test('bounded responses reject oversized or invalid UTF-8 source bodies', async () => {
  await assert.rejects(boundedText(new Response('12345'), 4), /TOO_LARGE/);
  await assert.rejects(boundedText(new Response(new Uint8Array([0xff]))), /INVALID_UTF8/);
});
test('bounded body failures retain their original plain Error and finite raw byte facts',async()=>{
  for(const [response,limit,message,bytes] of [[new Response(null),4,'CLOUD_EMPTY_RESPONSE',0],
    [new Response('元ab'),4,'CLOUD_RESPONSE_TOO_LARGE',5],[new Response(Uint8Array.of(255)),4,'CLOUD_INVALID_UTF8',1]]){
    await assert.rejects(boundedText(response,limit),error=>{
      assert.equal(Object.getPrototypeOf(error),Error.prototype);assert.equal(error.message,message);
      assert.equal(Object.hasOwn(error,'safeCode'),false);
      const evidence=createOwnerFailureEvidence(error);
      assert.equal(evidence.originalCode,message);assert.equal(evidence.read.readStage,'body');
      assert.equal(evidence.read.observedBodyBytes,bytes);assert.equal(evidence.read.bodyLimitBytes,limit);
      assert.equal(evidence.read.httpStatus,200);assert.equal(evidence.read.timeoutMs,null);
      return true;
    });
  }
});
test('body-reader errors retain identity and cancellation without inspecting error getters or proxy traps',async()=>{
  let traps=0;
  const forbidden=()=>{traps++;throw Error('SYNTHETIC_SECRET_CANARY');};
  const hostile=Object.defineProperties(new TypeError('SYNTHETIC_BODY_SECRET'),{
    ownerReadDiagnostics:{get:forbidden,configurable:true},safeCode:{get:forbidden},safeOrigin:{get:forbidden},cause:{get:forbidden}});
  const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const error of [hostile,new Proxy({}, {get:forbidden,getOwnPropertyDescriptor:forbidden,getPrototypeOf:forbidden,defineProperty:forbidden}),revoked.proxy]){
    let cancellations=0;
    const response={body:{getReader:()=>({read:async()=>{throw error;},cancel:async()=>{cancellations++;}})}};
    let caught;try{await boundedText(response,10);}catch(value){caught=value;}
    assert.equal(caught,error);
    assert.equal(cancellations,1);
    const evidence=createOwnerFailureEvidence(error);
    assert.equal(evidence.originalCode,null);assert.ok(!JSON.stringify(evidence).includes('SECRET'));
  }
  assert.equal(traps,0);
});
test('successful body diagnostics count original BOM bytes and hostile sinks cannot change success',async()=>{
  const bytes=Uint8Array.of(239,187,191,97),capture={};
  assert.equal(await boundedText(new Response(bytes),10,capture),'a');
  assert.equal(capture.value.observedBodyBytes,4);assert.equal(capture.value.bodyLimitBytes,10);
  let traps=0;const forbidden=()=>{traps++;throw Error('SYNTHETIC_SINK_SECRET');};
  const revoked=Proxy.revocable({},{});revoked.revoke();
  const sinks=[Object.freeze({}),Object.defineProperty({},'value',{get:forbidden,set:forbidden}),
    new Proxy({}, {get:forbidden,getPrototypeOf:forbidden,defineProperty:forbidden,set:forbidden}),revoked.proxy];
  for(const sink of sinks)assert.equal(await boundedText(new Response(bytes),10,sink),'a');
  assert.equal(traps,0);
});
test('finite failure evidence rejects malformed, inherited, extra, accessor and proxy values',()=>{
  const original=Object.assign(new TypeError('SYNTHETIC_PRIVATE_MESSAGE'),{cause:{code:'ETIMEDOUT'}});
  attachOwnerReadDiagnostics(original,{requestClass:'github-compare',readStage:'body',httpStatus:200,observedBodyBytes:4,bodyLimitBytes:2097152,elapsedMs:1,timeoutMs:15000});
  const valid=createOwnerFailureEvidence(original,{validatorPhase:'historical-authenticity',validatorPoint:'context-first'});
  assert.equal(valid.origin.type,'TypeError');assert.equal(valid.origin.causeCode,'ETIMEDOUT');
  assert.deepEqual(safeOwnerFailureEvidence(JSON.parse(JSON.stringify(valid))),valid);
  assert.ok(!JSON.stringify(valid).includes('PRIVATE'));
  assert.equal(createOwnerFailureEvidence(Error('CLOUD_RESPONSE_TOO_LARGE extra')).originalCode,null);
  const normalized=createOwnerFailureEvidence(original,{validatorPhase:'unknown',validatorPoint:'metadata'});
  assert.equal(normalized.validatorPhase,null);assert.equal(normalized.validatorPoint,'metadata');
  let traps=0;const forbidden=()=>{traps++;throw Error('SYNTHETIC_RECORD_SECRET');};
  for(const bad of [{...valid,extra:'SECRET'},{...valid,validatorPoint:'SECRET'},{...valid,origin:{...valid.origin,extra:1}},
    {...valid,read:{...valid.read,elapsedMs:86400001}},{...valid,read:{...valid.read,observedBodyBytes:-1}},
    {...valid,read:{...valid.read,bodyLimitBytes:Number.MAX_SAFE_INTEGER+1}},
    {...valid,read:{...valid.read,timeoutMs:45000}},{...valid,read:{...valid.read,httpStatus:600}},
    Object.create(valid),Object.defineProperty({...valid},'origin',{get:forbidden}),new Proxy(valid,{get:forbidden,getPrototypeOf:forbidden,ownKeys:forbidden})]){
    assert.equal(safeOwnerFailureEvidence(bad),null);
  }
  assert.equal(traps,0);
  assert.equal(safeOwnerReadDiagnostics({...valid.read,bodyLimitBytes:1.5}),null);
});
test('read classes contain only fixed repository route labels',()=>{
  const raw='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/'+'a'.repeat(40)+'/';
  assert.equal(ownerReadRequestClass(raw+'xuan-ib/latest.html'),'github-public-html');
  assert.equal(ownerReadRequestClass('https://api.github.com/repos/huanwujoy-crypto/fee-console/commits/main'),'github-main');
  for(const url of [raw+'xuan-ib/latest.html?SYNTHETIC_SECRET',raw+'unknown-private-route',raw.replace('/fee-console/','/other/')+'xuan-ib/latest.html'])assert.equal(ownerReadRequestClass(url),'other');
});
test('cloud IO only reads the two fixed credentials and saves the one IB credential', async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push({url: String(url), options});
    if (String(url).startsWith('http://metadata.')) return Response.json({access_token: 'test-google-identity'});
    if (String(url).includes('family-portfolio-gateway-key')) return Response.json({payload: {data: Buffer.from('test-read-token').toString('base64')}});
    if (String(url).endsWith(':access')) return Response.json({name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/14',payload: {data: Buffer.from('{"test":true}').toString('base64')}});
    return Response.json({name: 'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/15', state: 'ENABLED'});
  };
  const io = privateCloudIo({fetchImpl:lockTransport(fetchImpl)});
  assert.equal(await io.loadGatewayToken(), 'test-read-token');
  await io.ibStore.withCredentialLease(async lease=>{
    assert.deepEqual(await io.ibStore.load(), {test:true});await lease.beforeRefresh();
    assert.deepEqual(await io.ibStore.save({test:true}),{name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/15',state:'ENABLED'});
  });
  assert.equal(urls.filter(r => r.url.includes('metadata')).length, 1);
  assert.ok(urls.find(r => r.url.endsWith('xuan-preopen-ib-mcp:addVersion')).options.method === 'POST');
  assert.equal(urls.filter(r => r.url.endsWith(':addVersion')).length, 1);
});
test('private evidence uses immutable create-only upload and verifies object metadata', async () => {
  const requests = [], name = 'report-check/2026-09-30T05:00:00.000Z-id/report.html';
  const fetchImpl = async (url, options) => {
    if (String(url).includes('metadata.google')) return Response.json({access_token: 'test-google-identity'});
    requests.push({url: new URL(url), options});
    return Response.json({name, size: options.body.length, generation: '123'});
  };
  const io = privateCloudIo({fetchImpl}), result = await io.savePrivate(name, '<html>private</html>');
  assert.equal(result.generation, '123'); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(requests[0].url.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(requests[0].url.searchParams.get('name'), name);
  await assert.rejects(io.savePrivate('../report.html', 'invalid'), /PATH_INVALID/);
});
test('misrouted or incomplete upload metadata is not accepted', async () => {
  const fetchImpl = async url => String(url).includes('metadata.google') ? Response.json({access_token: 'test-google-identity'}) : Response.json({name: 'wrong-object', size: '1', generation: '1'});
  await assert.rejects(privateCloudIo({fetchImpl}).savePrivate('report-check/id/report.html', 'private'), /UPLOAD_NOT_CONFIRMED/);
});
test('B reads only its fixed Flex credential reference without token rotation or IB MCP access', async () => {
  const urls=[];
  const io=privateCloudIo({fetchImpl:async(url,options={})=>{
    urls.push({url:String(url),options});
    if(String(url).includes('metadata.google'))return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});
    assert.equal(String(url),'https://secretmanager.googleapis.com/v1/projects/family-portfolio-gateway/secrets/ib-flex-cash-token/versions/1:access');
    return Response.json({payload:{data:Buffer.from('SYNTHETIC_FLEX_TOKEN').toString('base64')}});
  }});
  assert.equal(await io.loadFlexToken(),'SYNTHETIC_FLEX_TOKEN');assert.equal(urls.length,2);
  assert(urls.every(r=>!r.url.includes('xuan-preopen-ib-mcp')&&!r.url.includes(':addVersion')&&r.options.method!=='POST'));
});
test('parallel B credential reads share one metadata identity request and never rotate secrets',async()=>{
  const calls=[];const io=privateCloudIo({fetchImpl:async url=>{
    calls.push(String(url));
    if(String(url).includes('metadata.google')){await new Promise(resolve=>setImmediate(resolve));return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});}
    return Response.json({payload:{data:Buffer.from('SYNTHETIC_READ_TOKEN').toString('base64')}});
  }});
  await Promise.all([io.loadFlexToken(),io.loadGatewayToken()]);
  assert.equal(calls.filter(url=>url.includes('metadata.google')).length,1);assert.equal(calls.length,3);
  assert(calls.some(url=>url.includes('ib-flex-cash-token/versions/1:access')));
  assert(calls.some(url=>url.includes('family-portfolio-gateway-key/versions/latest:access')));
  assert(calls.every(url=>!url.includes(':addVersion')));
});

test('bound versions reject aliases, partial pairs, traversal and accessors before any transport',async()=>{
  let calls=0;const io=privateCloudIo({fetchImpl:async()=>{calls++;throw Error('SYNTHETIC_PRIVATE_CANARY');}});
  for(const binding of [{version:'latest',clientId:'client'},{version:'01',clientId:'client'},{version:1,clientId:'client'},
    {version:'../1',clientId:'client'},{version:'1'},{clientId:'client'},{version:'1',clientId:'client',secret:'other'},
    {version:'1',clientId:null},{version:'1',clientId:'client\n--log-http'}]){
    await assert.rejects(io.ibStore.loadBound(binding),e=>e.message==='IB_READ_ONLY_CREDENTIAL_REQUIRED');
  }
  let accessed=false;assert.throws(()=>validateIbCredentialBinding({version:'1',get clientId(){accessed=true;return 'x';}}));
  assert.equal(accessed,false);assert.equal(calls,0);
});
test('bound access uses exactly one fixed numeric Secret version and checks response name and client',async()=>{
  for(const project of ['family-portfolio-gateway','860729177589']){
    const urls=[],credential={client_id:'SYNTHETIC_CLIENT',access_token:'SYNTHETIC_ACCESS_CANARY'};
    const io=privateCloudIo({fetchImpl:lockTransport(async(url,o)=>{urls.push(String(url));assert.equal(o.redirect,'error');
      return String(url).includes('metadata.google')?Response.json({access_token:'SYNTHETIC_GOOGLE_CANARY'}):Response.json({
        name:`projects/${project}/secrets/xuan-preopen-ib-mcp/versions/50`,payload:{data:Buffer.from(JSON.stringify(credential)).toString('base64')}});})});
    const result=await io.ibStore.withCredentialLease(()=>io.ibStore.loadBound({version:'50',clientId:'SYNTHETIC_CLIENT'}));
    assert.ok(result.credential.access_token===credential.access_token,'INTERNAL_CREDENTIAL_ONLY');
    assert.equal(result.versionName,`projects/${project}/secrets/xuan-preopen-ib-mcp/versions/50`);
    assert.equal(urls.length,2);assert.ok(urls[1].endsWith('/xuan-preopen-ib-mcp/versions/50:access'));
    assert.ok(!urls.some(u=>u.includes('latest')||u.includes(':addVersion')));
  }
});
test('wrong bound access names, duplicate JSON fields and client mismatches never fall back latest',async()=>{
  const prefix='projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/';
  for(const entry of [
    {name:prefix+'51'}, {name:'projects/other/secrets/xuan-preopen-ib-mcp/versions/50'},
    {name:'projects/family-portfolio-gateway/secrets/other/versions/50'}, {name:prefix+'latest'},
    {name:prefix+'50',text:'{"client_id":"other","access_token":"SYNTHETIC_ACCESS_CANARY"}'},
    {name:prefix+'50',text:'{"client_id":"other","client_\\u0069d":"SYNTHETIC_CLIENT"}'},
    {name:prefix+'50',outerDuplicate:true}, {name:prefix+'50',data:'!!!'},
  ]){
    const urls=[],io=privateCloudIo({fetchImpl:lockTransport(async url=>{urls.push(String(url));if(String(url).includes('metadata.google'))return Response.json({access_token:'SYNTHETIC_GOOGLE_CANARY'});
      const payload={data:entry.data??Buffer.from(entry.text??'{"client_id":"SYNTHETIC_CLIENT"}').toString('base64')};
      return entry.outerDuplicate?new Response('{"name":"SYNTHETIC_PRIVATE_CANARY","name":'+JSON.stringify(entry.name)+',"payload":'+JSON.stringify(payload)+'}'):Response.json({name:entry.name,payload});})});
    await assert.rejects(io.ibStore.withCredentialLease(()=>io.ibStore.loadBound({version:'50',clientId:'SYNTHETIC_CLIENT'})),e=>!JSON.stringify({message:e.message}).includes('CANARY'));
    assert.equal(urls.length,2);assert.ok(!urls.some(u=>u.includes('latest')));
  }
  assert.throws(()=>uniqueCloudJson('{"x":1,"\\u0078":2}'));
  assert.throws(()=>validateBoundIbVersionName(prefix+'50','51'));
});

// All lease fixtures are synthetic; HTTP and credential calls are injected.
function casFixture(initial=null){
  let value=structuredClone(initial),generation=initial?'1':'0',time=1000000;
  const writes=[],reads=[];
  const read=async()=>{reads.push(generation);return {value:structuredClone(value),generation};};
  const cas=async(expected,next)=>{
    if(expected!==generation)throw Error('CLOUD_HTTP_412');
    value=structuredClone(next);generation=String(BigInt(generation)+1n);writes.push(structuredClone(value));return generation;
  };
  return {read,cas,writes,reads,now:()=>time,advance:ms=>time+=ms,get:()=>({value:structuredClone(value),generation}),
    lease:overrides=>createIbCredentialLease({read,cas,now:()=>time,...overrides})};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const lockRow=(phase,expiresAt=1,lastSavedVersion=null)=>({schema:1,owner:'11111111-2222-4333-8444-555555555555',phase,expiresAt:phase==='idle'?null:expiresAt,lastSavedVersion});
test('CAS serializes competing instances before either credential callback starts',async()=>{
  const f=casFixture(),entered=deferred(),finish=deferred();let callbacks=0;
  const first=f.lease().run(async()=>{callbacks++;entered.resolve();await finish.promise;return 'first';});
  await entered.promise;await assert.rejects(f.lease().run(()=>{callbacks++;}),/LEASE_BUSY/);
  assert.equal(callbacks,1);finish.resolve();assert.equal(await first,'first');
  await f.lease().run(()=>{callbacks++;});assert.equal(callbacks,2);
  assert.deepEqual(f.writes.map(v=>v.phase),['loading','idle','loading','idle']);
});
test('simultaneous empty-record CAS contenders cannot both execute',async()=>{
  const f=casFixture(),ready=deferred(),finish=deferred();let arrivals=0,callbacks=0;
  const read=async()=>{const row=await f.read();if(row.generation==='0'&&++arrivals<2)await ready.promise;else ready.resolve();return row;};
  const runs=[1,2].map(()=>f.lease({read}).run(async()=>{callbacks++;await finish.promise;}));const settled=Promise.allSettled(runs);
  await new Promise(r=>setImmediate(r));finish.resolve();const results=await settled;
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(callbacks,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/LEASE_CONFLICT/);
});
test('same in-process lease also refuses reentry without touching storage',async()=>{
  const f=casFixture(),lease=f.lease();await lease.run(async()=>{const before=f.reads.length;await assert.rejects(lease.run(()=>assert.fail()),/LEASE_BUSY/);assert.equal(f.reads.length,before);});
});
test('expired loading can be reclaimed, but its prior holder cannot refresh or release successor',async()=>{
  const f=casFixture(),entered=deferred(),continueOld=deferred(),newEntered=deferred(),finishNew=deferred();let oldRefreshes=0;
  const old=f.lease().run(async l=>{l.loaded('10');entered.resolve();await continueOld.promise;await l.beforeRefresh();oldRefreshes++;});
  const observed=old.catch(e=>e);await entered.promise;f.advance(120001);
  const next=f.lease().run(async()=>{newEntered.resolve();await finishNew.promise;});await newEntered.promise;
  continueOld.resolve();assert.match((await observed).message,/LEASE_LOST/);assert.equal(oldRefreshes,0);
  assert.equal(f.get().value.phase,'loading');finishNew.resolve();await next;assert.equal(f.get().value.phase,'idle');
});
test('expired loading holder without successor cannot dispatch refresh',async()=>{
  const f=casFixture();let refreshes=0;
  await assert.rejects(f.lease().run(async l=>{l.loaded('10');f.advance(120000);await l.beforeRefresh();refreshes++;}),/LEASE_EXPIRED/);
  assert.equal(refreshes,0);assert.equal(f.get().value.phase,'idle');
});
test('expired refreshing and saving phases never authorize takeover',async()=>{
  for(const phase of ['refreshing','saving']){const f=casFixture(lockRow(phase));await assert.rejects(f.lease().run(()=>assert.fail()),/RECOVERY_REQUIRED/);assert.equal(f.writes.length,0);}
});
test('unknown OAuth outcome keeps durable refresh marker and blocks all later readers',async()=>{
  const f=casFixture();await assert.rejects(f.lease().run(async l=>{l.loaded('10');await l.beforeRefresh();throw Error('SYNTHETIC_OAUTH_OUTCOME_UNKNOWN');}),/OAUTH_OUTCOME_UNKNOWN/);
  f.advance(999999);await assert.rejects(f.lease().run(()=>assert.fail()),/RECOVERY_REQUIRED/);
  assert.deepEqual(f.writes.map(v=>v.phase),['loading','refreshing']);
});
test('unknown Secret save outcome cannot unlock or automatically rotate again',async()=>{
  const f=casFixture();await assert.rejects(f.lease().run(async l=>{l.loaded('10');await l.beforeRefresh();await l.beforeSave();throw Error('SYNTHETIC_SAVE_UNKNOWN');}),/SAVE_UNKNOWN/);
  f.advance(999999);await assert.rejects(f.lease().run(()=>assert.fail()),/RECOVERY_REQUIRED/);
  assert.deepEqual(f.writes.map(v=>v.phase),['loading','refreshing','saving']);
});
test('confirmed rotation can finish after TTL; only subsequent numeric versions are accepted',async()=>{
  const f=casFixture();await f.lease().run(async l=>{l.loaded('10');await l.beforeRefresh();f.advance(999999);await l.beforeSave();l.saved('projects/synthetic/secrets/one/versions/11');});
  assert.equal(f.get().value.lastSavedVersion,'11');
  await assert.rejects(f.lease().run(l=>l.assertLoading('10')),/BINDING_STALE/);
  await f.lease().run(async l=>{await l.assertLoading('11');l.loaded('11');});
  assert.equal(f.get().value.lastSavedVersion,'11');
});
test('unknown acquire, phase and release CAS responses are confirmed by one readback without resubmission',async()=>{
  for(const lostPhase of ['loading','refreshing','saving','idle']){
    const f=casFixture();let uncertain=0,casCalls=0;
    const lease=f.lease({cas:async(g,v)=>{casCalls++;const next=await f.cas(g,v);if(v.phase===lostPhase&&!uncertain++){throw Error('NETWORK_RESULT_UNKNOWN');}return next;}});
    await lease.run(async l=>{l.loaded('10');await l.beforeRefresh();await l.beforeSave();l.saved('x/11');});
    assert.equal(casCalls,4);assert.equal(f.get().value.phase,'idle');assert.equal(f.get().value.lastSavedVersion,'11');
  }
});
test('unconfirmed acquisition never enters credential code or retries the write',async()=>{
  const f=casFixture();let casCalls=0;
  await assert.rejects(f.lease({cas:async()=>{casCalls++;throw Error('UNKNOWN');}}).run(()=>assert.fail()),/OUTCOME_UNKNOWN/);
  assert.equal(casCalls,1);assert.equal(f.reads.length,2);assert.equal(f.writes.length,0);
});
test('committed refresh with unavailable readback cannot dispatch OAuth or erase marker',async()=>{
  const f=casFixture();let readFails=false,oauth=0;
  const lease=f.lease({read:async()=>{if(readFails)throw Error('UNAVAILABLE');return f.read();},cas:async(g,v)=>{const n=await f.cas(g,v);if(v.phase==='refreshing'){readFails=true;throw Error('UNKNOWN');}return n;}});
  await assert.rejects(lease.run(async l=>{l.loaded('10');await l.beforeRefresh();oauth++;}));
  assert.equal(oauth,0);assert.equal(f.get().value.phase,'refreshing');assert.equal(f.writes.length,2);
});
test('unknown release blocks success and leaves critical record for recovery',async()=>{
  const f=casFixture();let releaseCalls=0;
  await assert.rejects(f.lease({cas:async(g,v)=>{if(v.phase==='idle'){releaseCalls++;throw Error('UNKNOWN');}return f.cas(g,v);}}).run(async l=>{l.loaded('10');await l.beforeRefresh();await l.beforeSave();l.saved('x/11');return 'credential';}),/OUTCOME_UNKNOWN/);
  assert.equal(releaseCalls,1);assert.equal(f.get().value.phase,'saving');
  await assert.rejects(f.lease().run(()=>assert.fail()),/RECOVERY_REQUIRED/);
});
test('malformed records and non-increasing rotation versions fail closed',async()=>{
  for(const bad of [{...lockRow('idle'),extra:'PRIVATE'},lockRow('loading',NaN),lockRow('idle',null,12),{...lockRow('idle'),owner:'bad'},lockRow('unknown')]){
    const f=casFixture(bad);await assert.rejects(f.lease().run(()=>assert.fail()),/LEASE_INVALID/);assert.equal(f.writes.length,0);
  }
  const f=casFixture();await assert.rejects(f.lease().run(async l=>{l.loaded('10');await l.beforeRefresh();await l.beforeSave();l.saved('x/10');}),/ROTATION_OUTCOME_UNKNOWN/);assert.equal(f.get().value.phase,'saving');
});
test('cloud credentials cannot be loaded or saved without their shared lease',async()=>{
  let calls=0;const io=privateCloudIo({fetchImpl:async()=>{calls++;assert.fail('No transport');}});
  await assert.rejects(io.ibStore.load(),/LEASE_REQUIRED/);await assert.rejects(io.ibStore.save({}),/LEASE_REQUIRED/);
  await assert.rejects(io.ibStore.loadBound({clientId:'SYNTHETIC',version:'1'}),/LEASE_REQUIRED/);assert.equal(calls,0);
});
test('fixed lock HTTP capability rejects unrelated objects, deletion, aliases and hidden fields',()=>{
  const meta='https://storage.googleapis.com/storage/v1/b/family-portfolio-gateway-xuan-preopen-private/o/'+encodeURIComponent(IB_CREDENTIAL_LOCK_KEY);
  const upload='https://storage.googleapis.com/upload/storage/v1/b/family-portfolio-gateway-xuan-preopen-private/o?uploadType=media&name='+encodeURIComponent(IB_CREDENTIAL_LOCK_KEY)+'&ifGenerationMatch=0';
  const options={method:'POST',body:JSON.stringify(lockRow('loading'))};
  assert.equal(isIbCredentialLockRequest(meta),true);assert.equal(isIbCredentialLockRequest(meta+'?alt=media&generation=1'),true);assert.equal(isIbCredentialLockRequest(upload,options),true);
  for(const [url,o] of [[meta,{method:'DELETE'}],[meta+'?alt=media',{}],[meta+'?generation=0&alt=media',{}],[meta+'?alt=media&generation=1&generation=2',{}],[meta+'/other',{}],[meta.replace('https://','https://user@'),{}],[meta+'#hidden',{}],[upload.replace('lease.json','other.json'),options],[upload,{...options,body:JSON.stringify({...lockRow('idle'),token:'SYNTHETIC_SECRET'})}]])assert.equal(isIbCredentialLockRequest(url,o),false);
});
