import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOwnerLatestStore,MAX_METADATA_BYTES,MAX_SOURCE_BYTES} from './owner_latest_store.mjs';
import {createOwnerLatestPublisher,OWNER_SCOPE,LATEST_TARGET,LATEST_HEADERS,MAX_BYTES,
  ACCEPTED_PREVIEW_SCHEMA,previewMetadataSha256} from './owner_latest.mjs';

// Synthetic transport only. Every URL terminates in this in-memory fake; tests
// neither use credentials nor make network, account, source or storage calls.
const encode=text=>new TextEncoder().encode(text),decode=bytes=>new TextDecoder().decode(bytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const NOW=Date.parse('2026-10-17T10:00:00.000Z'),OWNER='a'.repeat(64);
const sourceName='report-check/2026-10-16T12:00:00.000Z-11111111-2222-4333-8444-555555555555/sharesight.noahPerformance.json';
const jsonResponse=value=>{const bytes=encode(JSON.stringify(value));return new Response(bytes,{headers:{'content-type':'application/json; charset=utf-8','content-length':String(bytes.length)}});};
function fixture(){
  const html=encode('<!doctype html><p>Synthetic private report</p>'),receipt=encode('{"synthetic":true}');
  const metadata={schema:'xuan.owner-latest.v1',scope:OWNER_SCOPE,ownerBinding:OWNER,sourceIdentitySha256:'b'.repeat(64),
    dataDate:'2026-10-16',sourceDate:'2026-10-16',captureStartedAt:'2026-10-16T12:00:00.000Z',
    captureEndedAt:'2026-10-16T12:01:00.000Z',completedAt:'2026-10-16T12:02:00.000Z',
    artifactObject:'delivery/2026-10-16/report.html',artifactGeneration:'31',artifactSha256:hash(html),
    receiptObject:'delivery/2026-10-16/receipt.json',receiptGeneration:'32',receiptSha256:hash(receipt),
    financialStatus:'partial',unknownFields:['orders']};
  return {html,receipt,metadata};
}
function custom(bundle,display=bundle.html){const m=bundle.metadata;return {
  bundleMetadata:JSON.stringify(m),displaySha256:hash(display),artifactObject:m.artifactObject,
  artifactGeneration:m.artifactGeneration,artifactSha256:m.artifactSha256,receiptObject:m.receiptObject,
  receiptGeneration:m.receiptGeneration,receiptSha256:m.receiptSha256};}
function fake({latest=false,intercept}={}){
  const records=new Map(),heads=new Map(),calls=[],bundle=fixture();let generation=100;
  const add=(name,gen,bytes,latestMetadata)=>{
    const metadata={bucket:LATEST_TARGET.bucket,name,generation:gen,size:String(bytes.length),
      ...(latestMetadata?{...LATEST_HEADERS,metadata:latestMetadata}:{contentType:'application/octet-stream'})};
    records.set(name+'@'+gen,{bytes:new Uint8Array(bytes),metadata});heads.set(name,gen);return metadata;
  };
  add(bundle.metadata.artifactObject,'31',bundle.html);add(bundle.metadata.receiptObject,'32',bundle.receipt);
  if(latest)add(LATEST_TARGET.object,'7',bundle.html,custom(bundle));
  const request=async(url,options={})=>{
    const u=new URL(url),method=options.method||'GET',call={url,options};calls.push(call);
    assert.equal(u.origin,'https://storage.googleapis.com');assert.equal(options.redirect,'error');
    assert.equal(u.searchParams.has('access_token'),false);
    if(intercept){const override=await intercept(call,{add,records,heads,bundle});if(override!==undefined)return override;}
    if(method==='POST'){
      assert.equal(u.pathname,'/upload/storage/v1/b/'+LATEST_TARGET.bucket+'/o');
      assert.equal(u.searchParams.get('uploadType'),'multipart');
      assert.deepEqual([...u.searchParams.keys()].sort(),['ifGenerationMatch','uploadType']);
      const expected=u.searchParams.get('ifGenerationMatch');
      if((heads.get(LATEST_TARGET.object)||'0')!==expected)return new Response(null,{status:412});
      const raw=Buffer.from(options.body),boundary=options.headers['Content-Type'].split('boundary=')[1];
      const first=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n');
      const middle=Buffer.from('\r\n--'+boundary+'\r\nContent-Type: '+LATEST_HEADERS.contentType+'\r\n\r\n');
      assert.equal(raw.subarray(0,first.length).equals(first),true);
      const at=raw.indexOf(middle),resource=JSON.parse(raw.subarray(first.length,at).toString());
      const tail=Buffer.from('\r\n--'+boundary+'--\r\n');assert.equal(raw.subarray(-tail.length).equals(tail),true);
      const bytes=new Uint8Array(raw.subarray(at+middle.length,-tail.length));
      assert.equal(resource.name,LATEST_TARGET.object);assert.equal(resource.contentType,LATEST_HEADERS.contentType);
      assert.equal(resource.contentDisposition,LATEST_HEADERS.contentDisposition);assert.equal(resource.cacheControl,LATEST_HEADERS.cacheControl);
      const ack=add(resource.name,String(++generation),bytes,resource.metadata);
      // GCS may reorder custom metadata keys. Their strings must still bind.
      ack.metadata=Object.fromEntries(Object.entries(ack.metadata).reverse());return jsonResponse(ack);
    }
    assert.equal(u.pathname.startsWith('/storage/v1/b/'+LATEST_TARGET.bucket+'/o/'),true);
    const name=decodeURIComponent(u.pathname.split('/o/')[1]);
    if(method==='HEAD'){
      assert.equal(u.searchParams.get('alt'),'media');assert.equal(u.searchParams.has('generation'),false);
      const gen=heads.get(name),record=records.get(name+'@'+gen);if(!record)return new Response(null,{status:404});
      return new Response(null,{headers:mediaHeaders(record)});
    }
    assert.equal(method,'GET');const gen=u.searchParams.get('generation');assert.match(gen||'',/^[1-9][0-9]*$/);
    const record=records.get(name+'@'+gen);if(!record)return new Response(null,{status:404});
    return u.searchParams.get('alt')==='media'?new Response(record.bytes,{headers:mediaHeaders(record)}):jsonResponse(record.metadata);
  };
  function mediaHeaders(record){const m=record.metadata;return {'x-goog-generation':m.generation,'content-length':m.size,
    'content-type':m.contentType,...(m.contentDisposition?{'content-disposition':m.contentDisposition}:{}),...(m.cacheControl?{'cache-control':m.cacheControl}:{})};}
  return {request,records,heads,calls,bundle,add,store:createOwnerLatestStore({request})};
}

test('store requires explicit transport and makes no construction requests',()=>{
  assert.throws(()=>createOwnerLatestStore(),/REQUEST_CAPABILITY_REQUIRED/);
  const f=fake();assert.equal(f.calls.length,0);
});
test('already aborted operations make no transport request',async()=>{
  const f=fake(),controller=new AbortController();controller.abort();
  await assert.rejects(f.store.readLatest({signal:controller.signal}),/ABORTED/);
  await assert.rejects(f.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:f.bundle.html,
    metadata:{...f.bundle.metadata,displaySha256:hash(f.bundle.html)},signal:controller.signal}),/ABORTED/);
  assert.equal(f.calls.length,0);
});
test('only fixed latest HEAD 404 is absent; denied and pinned-missing reads are errors',async()=>{
  const f=fake();assert.deepEqual(await f.store.readLatest(),{state:'absent'});assert.equal(f.calls.length,1);
  for(const status of [401,403,500]){
    const g=fake({intercept:()=>new Response(null,{status})});await assert.rejects(g.store.readLatest());assert.equal(g.calls.length,1);
  }
  const g=fake({latest:true,intercept:({options})=>options.method==='GET'?new Response(null,{status:404}):undefined});
  await assert.rejects(g.store.readLatest(),/PINNED_OBJECT_MISSING/);assert.equal(g.calls.length,2);
});
test('reads actual immutable original HTML and receipt; custom hashes alone do not authenticate them',async()=>{
  const f=fake({latest:true}),current=await f.store.readLatest();assert.equal(current.generation,'7');
  assert.deepEqual(current.bundle.html,f.bundle.html);assert.deepEqual(current.bundle.receipt,f.bundle.receipt);
  assert.equal(f.calls.filter(c=>c.options.method==='GET').length,6);
  f.records.get(f.bundle.metadata.artifactObject+'@31').bytes[0]^=1;
  await assert.rejects(f.store.readLatest(),/CONTENT_HASH_MISMATCH/);
});
test('current generation stays pinned across concurrent replacement',async()=>{
  let switched=false;
  const f=fake({latest:true,intercept:({options},{heads,add,bundle})=>{
    if(options.method==='GET'&&!switched){switched=true;add(LATEST_TARGET.object,'8',encode('SYNTHETIC NEWER LATEST'),custom(bundle));heads.set(LATEST_TARGET.object,'8');}
  }});
  const current=await f.store.readLatest();assert.equal(current.generation,'7');assert.deepEqual(current.displayBytes,f.bundle.html);
  const latestGets=f.calls.filter(c=>c.options.method==='GET'&&c.url.includes(encodeURIComponent(LATEST_TARGET.object)));
  assert.ok(latestGets.every(c=>new URL(c.url).searchParams.get('generation')==='7'));
});
test('daily read discovers and pins the two exact objects without trusting recomputed receipt JSON',async()=>{
  const f=fake(),r=await f.store.readDailyBundle({dataDate:'2026-10-16'});
  assert.deepEqual(r.html,f.bundle.html);assert.deepEqual(r.receipt,f.bundle.receipt);
  assert.equal(r.artifactGeneration,'31');assert.equal(r.receiptGeneration,'32');assert.equal(r.receiptSha256,hash(f.bundle.receipt));
  assert.equal(f.calls.length,6);assert.ok(f.calls.every(c=>!c.url.includes('report-check')));
});
test('rejects invalid source, date and target inputs before any transport use',async()=>{
  const f=fake();
  for(const dataDate of ['2026-02-30','2026-10-16/../../','2026-10-16?x=1'])await assert.rejects(f.store.readDailyBundle({dataDate}));
  for(const name of ['https://attacker.invalid/','report-check/id/orders.json',sourceName.replace('sharesight.noahPerformance','secret'),sourceName.replace('2026-10-16','2026-02-30')])
    await assert.rejects(f.store.readPinnedSource({name,generation:'1',sha256:'a'.repeat(64)}));
  await assert.rejects(f.store.readLatest({target:{...LATEST_TARGET,bucket:'other'}}));
  await assert.rejects(f.store.readLatestGeneration({generation:'0',sha256:'a'.repeat(64)}));assert.equal(f.calls.length,0);
});
test('strict source-manifest family reads only pinned raw bytes and validates hash',async()=>{
  const f=fake(),bytes=encode('{"syntheticSource":true}');f.add(sourceName,'81',bytes);
  assert.deepEqual(await f.store.readPinnedSource({name:sourceName,generation:'81',sha256:hash(bytes)}),bytes);
  await assert.rejects(f.store.readPinnedSource({name:sourceName,generation:'81',sha256:'d'.repeat(64)}),/CONTENT_HASH_MISMATCH/);
  assert.ok(f.calls.every(c=>new URL(c.url).searchParams.get('generation')==='81'));
});
test('metadata redundant original generation/hash values cannot disagree',async()=>{
  const f=fake({latest:true});f.records.get(LATEST_TARGET.object+'@7').metadata.metadata.artifactGeneration='99';
  await assert.rejects(f.store.readLatest(),/CUSTOM_METADATA_INVALID/);
  assert.equal(f.calls.length,2);
});
test('duplicate metadata JSON keys are rejected before object binding',async()=>{
  const f=fake({intercept:({url})=>!new URL(url).searchParams.has('alt')
    ?new Response('{"generation":"999","generation":"31"}',{headers:{'content-type':'application/json'}}):undefined});
  await assert.rejects(f.store.readDailyBundle({dataDate:'2026-10-16'}),/METADATA_JSON_INVALID/);
});
test('metadata size, media length, generation header and encoding are enforced',async t=>{
  const cases=[
    ['metadata size',({url})=>!new URL(url).searchParams.has('alt')?new Response('x',{headers:{'content-type':'application/json','content-length':String(MAX_METADATA_BYTES+1)}}):undefined],
    ['metadata name',({url},{bundle})=>!new URL(url).searchParams.has('alt')?jsonResponse({bucket:LATEST_TARGET.bucket,name:'wrong',generation:'31',size:String(bundle.html.length)}):undefined],
    ['media generation',({url,options},{bundle})=>options.method==='GET'&&new URL(url).searchParams.get('alt')==='media'?new Response(bundle.html,{headers:{'x-goog-generation':'999','content-length':String(bundle.html.length)}}):undefined],
    ['media length',({url,options},{bundle})=>options.method==='GET'&&new URL(url).searchParams.get('alt')==='media'?new Response(bundle.html,{headers:{'x-goog-generation':'31','content-length':String(bundle.html.length+1)}}):undefined],
    ['media encoding',({url,options},{bundle})=>options.method==='GET'&&new URL(url).searchParams.get('alt')==='media'?new Response(bundle.html,{headers:{'x-goog-generation':'31','content-length':String(bundle.html.length),'content-encoding':'gzip'}}):undefined],
    ['partial media',({url,options})=>options.method==='GET'&&new URL(url).searchParams.get('alt')==='media'?new Response('x',{status:206}):undefined],
  ];
  for(const [name,intercept] of cases)await t.test(name,async()=>{
    const f=fake({intercept});await assert.rejects(f.store.readDailyBundle({dataDate:'2026-10-16'}));
  });
});
test('streamed body exceeding size limit is rejected independently of headers',async()=>{
  const f=fake({intercept:({url,options},{bundle})=>options.method==='GET'&&new URL(url).searchParams.get('alt')==='media'
    ?new Response(new Uint8Array(MAX_BYTES+1),{headers:{'x-goog-generation':'31','content-length':String(bundle.html.length)}}):undefined});
  await assert.rejects(f.store.readDailyBundle({dataDate:'2026-10-16'}),/SIZE_LIMIT/);
});
test('CAS multipart stores exact UTF8 display plus string metadata atomically; readback is a new GET',async()=>{
  const f=fake(),display=encode('<!doctype html><p>Synthetic 中文 display</p>');
  const ack=await f.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:display,
    metadata:{...f.bundle.metadata,displaySha256:hash(display)}});
  assert.equal(ack.generation,'101');assert.equal(ack.size,display.length);assert.equal(f.calls.length,1);
  const saved=f.records.get(LATEST_TARGET.object+'@101');assert.deepEqual(saved.bytes,display);
  assert.equal(typeof saved.metadata.metadata.bundleMetadata,'string');
  assert.ok(Object.values(saved.metadata.metadata).every(v=>typeof v==='string'));
  assert.deepEqual(await f.store.readLatestGeneration({generation:ack.generation,sha256:hash(display)}),display);
  assert.deepEqual(f.calls.map(c=>c.options.method),['POST','GET','GET']);
});
test('CAS rejects explicit conflict once and never issues retries after an uncertain upload',async()=>{
  const f=fake({latest:true});await assert.rejects(f.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,
    bytes:f.bundle.html,metadata:{...f.bundle.metadata,displaySha256:hash(f.bundle.html)}}),e=>e.status===412);
  assert.equal(f.calls.length,1);
  const g=fake({intercept:({options})=>{if(options.method==='POST')throw Error('SYNTHETIC_LOST_ACK');}});
  await assert.rejects(g.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:g.bundle.html,
    metadata:{...g.bundle.metadata,displaySha256:hash(g.bundle.html)}}),/LOST_ACK/);assert.equal(g.calls.length,1);
});
test('raw readback verifies stored custom metadata, including original receipt pins, beyond upload ACK',async()=>{
  const f=fake(),expected={...f.bundle.metadata,displaySha256:hash(f.bundle.html)};
  const ack=await f.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:f.bundle.html,metadata:expected});
  const m=f.records.get(LATEST_TARGET.object+'@'+ack.generation).metadata.metadata;
  const altered=JSON.parse(m.bundleMetadata);altered.receiptGeneration='999';
  m.bundleMetadata=JSON.stringify(altered);m.receiptGeneration='999';
  await assert.rejects(f.store.readLatestGeneration({generation:ack.generation,sha256:hash(f.bundle.html),metadata:expected}),/READBACK_METADATA_MISMATCH/);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});
test('correct ACK followed by metadata mutation cannot produce published-verified',async t=>{
  for(const [name,edit] of [
    ['missing',m=>{delete m.metadata;}],
    ['original reference',m=>{const bundle=JSON.parse(m.metadata.bundleMetadata);bundle.receiptGeneration='999';m.metadata.bundleMetadata=JSON.stringify(bundle);m.metadata.receiptGeneration='999';}],
    ['display hash',m=>{m.metadata.displaySha256='d'.repeat(64);}],
  ])await t.test(name,async()=>{
    let changed=false;
    const f=fake({intercept:({options},{heads,records})=>{
      const generation=heads.get(LATEST_TARGET.object);
      if(options.method==='GET'&&generation&&!changed){changed=true;edit(records.get(LATEST_TARGET.object+'@'+generation).metadata);}
    }});
    const p=createOwnerLatestPublisher({io:f.store,ownerBinding:OWNER,now:()=>NOW,prepareDisplay:bytes=>new Uint8Array(bytes),
      verifyProtectedReceipt:({metadata:m})=>({scope:m.scope,ownerBinding:m.ownerBinding,sourceIdentitySha256:m.sourceIdentitySha256,
        artifactSha256:m.artifactSha256,receiptSha256:m.receiptSha256,policyRevision:'c'.repeat(64),financialStatus:m.financialStatus})});
    assert.equal((await p.publish(f.bundle)).status,'unknown');assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  });
});
test('wrong ACK metadata, generation, or headers never confirms a write',async t=>{
  for(const [name,edit] of [['hash',m=>{m.metadata.displaySha256='d'.repeat(64);}],['generation',m=>{m.generation='7';}],['headers',m=>{m.cacheControl='public';}]])
    await t.test(name,async()=>{
      const f=fake({latest:true,intercept:({options},{bundle})=>{
        if(options.method!=='POST')return;const m={bucket:LATEST_TARGET.bucket,name:LATEST_TARGET.object,generation:'8',
          size:String(bundle.html.length),...LATEST_HEADERS,metadata:custom(bundle)};edit(m);return jsonResponse(m);
      }});
      await assert.rejects(f.store.replaceLatest({ifGenerationMatch:'7',headers:LATEST_HEADERS,bytes:f.bundle.html,
        metadata:{...f.bundle.metadata,displaySha256:hash(f.bundle.html)}}));assert.equal(f.calls.length,1);
    });
});
test('actual publisher + injected store verifies raw readback and retains original report pins',async()=>{
  const f=fake(),p=createOwnerLatestPublisher({io:f.store,ownerBinding:OWNER,now:()=>NOW,
    prepareDisplay:bytes=>new Uint8Array(bytes),verifyProtectedReceipt:({metadata:m})=>({scope:m.scope,
      ownerBinding:m.ownerBinding,sourceIdentitySha256:m.sourceIdentitySha256,artifactSha256:m.artifactSha256,
      receiptSha256:m.receiptSha256,policyRevision:'c'.repeat(64),financialStatus:m.financialStatus})});
  const result=await p.publish(f.bundle);assert.equal(result.status,'published-verified');assert.equal(result.generation,'101');
  assert.deepEqual(f.calls.map(c=>c.options.method),['HEAD','POST','GET','GET']);
  const current=await f.store.readLatest();assert.deepEqual(current.bundle.metadata,f.bundle.metadata);
  assert.deepEqual(current.bundle.receipt,f.bundle.receipt);assert.equal((await p.publish(f.bundle)).code,'ONE_SHOT_CLOSED');
});

function previewMetadata(){return {schema:ACCEPTED_PREVIEW_SCHEMA,scope:OWNER_SCOPE,ownerBinding:OWNER,
  sourceIdentitySha256:'b'.repeat(64),registrationId:'saturday-acceptance-20261017',registrationSha256:'d'.repeat(64),
  registrationPolicyCommit:'e'.repeat(40),dataDate:'2026-10-17',sourceDate:'2026-10-16',
  captureStartedAt:'2026-10-17T06:54:46.000Z',captureEndedAt:'2026-10-17T06:56:43.000Z',completedAt:'2026-10-17T07:00:00.000Z',
  financialStatus:'partial',unknownFields:['orders','cash','prices']};}
const previewDisplay=()=>encode('<!doctype html><p>Synthetic accepted Saturday preview</p>');
const previewCustom=(metadata,bytes)=>({previewMetadata:JSON.stringify(Object.fromEntries(Object.keys(metadata).sort().map(key=>[key,metadata[key]]))),displaySha256:hash(bytes)});
test('presence probe treats every existing object as present without inspecting headers, metadata or body',async()=>{
  const f=fake({intercept:()=>{
    const response=new Response('SYNTHETIC INVALID OLD OBJECT');
    Object.defineProperty(response,'body',{get(){throw Error('must not inspect body');}});return response;
  }});
  assert.deepEqual(await f.store.probeLatestExists(),{state:'present'});
  await assert.rejects(f.store.createAcceptedPreview({bytes:previewDisplay(),metadata:previewMetadata()}),/LATEST_ALREADY_EXISTS/);
  assert.deepEqual(f.calls.map(c=>c.options.method),['HEAD','HEAD']);
});
test('preview first-create uses only CAS0 and stores mutually exclusive canonical preview metadata',async()=>{
  const f=fake(),bytes=previewDisplay(),metadata=previewMetadata();
  const ack=await f.store.createAcceptedPreview({bytes,metadata});assert.equal(ack.generation,'101');
  assert.deepEqual(f.calls.map(c=>c.options.method),['HEAD','POST']);
  const saved=f.records.get(LATEST_TARGET.object+'@101');
  assert.deepEqual(Object.keys(saved.metadata.metadata).sort(),['displaySha256','previewMetadata']);
  assert.equal(JSON.parse(saved.metadata.metadata.previewMetadata).dataDate,'2026-10-17');
  assert.equal(new URL(f.calls[1].url).searchParams.get('ifGenerationMatch'),'0');
  assert.deepEqual(await f.store.readLatestGeneration({generation:ack.generation,sha256:hash(bytes),metadata:{...metadata,displaySha256:hash(bytes)}}),bytes);
  await assert.rejects(f.store.createAcceptedPreview({bytes,metadata}),/PREVIEW_CREATE_CLOSED/);
});
test('accepted preview history reads only fixed latest metadata and actual bytes, never nonexistent daily objects',async()=>{
  const f=fake(),bytes=previewDisplay(),metadata=previewMetadata();f.add(LATEST_TARGET.object,'7',bytes,previewCustom(metadata,bytes));
  const current=await f.store.readLatest();
  assert.deepEqual(current,{state:'present',kind:'accepted-preview',generation:'7',preview:{metadata},displayBytes:bytes});
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.url.includes(encodeURIComponent(LATEST_TARGET.object))));
  assert.equal(Object.hasOwn(current,'bundle'),false);
});
test('preview can never overwrite, and existing malformed or daily targets cause zero POST',async()=>{
  const f=fake();await assert.rejects(f.store.replaceLatest({ifGenerationMatch:'7',headers:LATEST_HEADERS,bytes:previewDisplay(),
    metadata:{...previewMetadata(),displaySha256:hash(previewDisplay())}}),/PREVIEW_CREATE_ONLY/);assert.equal(f.calls.length,0);
  const g=fake({latest:true});await assert.rejects(g.store.createAcceptedPreview({bytes:previewDisplay(),metadata:previewMetadata()}),/LATEST_ALREADY_EXISTS/);
  assert.deepEqual(g.calls.map(c=>c.options.method),['HEAD']);
});
test('public replaceLatest cannot admit preview CAS0 or forge the private create capability',async()=>{
  for(const latest of [false,true]){
    const f=fake({latest}),input={ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:previewDisplay(),
      metadata:{...previewMetadata(),displaySha256:hash(previewDisplay())},previewAdmission:true,admitted:true,token:Symbol('forged')};
    await assert.rejects(f.store.replaceLatest(input),/PREVIEW_CREATE_REQUIRED/);
    await assert.rejects(f.store.replaceLatest(input,Symbol('private-preview-create-admission')),/PREVIEW_CREATE_REQUIRED/);
    assert.equal(f.calls.length,0,'raw preview replacement cannot issue HEAD, GET or POST');
  }
});
test('any exceptional first-create call closes preview admission before a later corrected call',async()=>{
  for(const invalid of [null,undefined,{bytes:new Uint8Array(),metadata:previewMetadata()}]){
    const f=fake();await assert.rejects(f.store.createAcceptedPreview(invalid),/WRITE_INVALID/);
    await assert.rejects(f.store.createAcceptedPreview({bytes:previewDisplay(),metadata:previewMetadata()}),/PREVIEW_CREATE_CLOSED/);
    assert.equal(f.calls.length,0);
  }
});
test('preview first-create denies unknown/forbidden HEAD, concurrent 412 and uncertain POST without retry',async t=>{
  for(const [name,intercept,methods] of [
    ['denied',()=>new Response(null,{status:403}),['HEAD']],
    ['unknown',()=>{throw Error('SYNTHETIC_HEAD_UNAVAILABLE');},['HEAD']],
    ['race',({options})=>options.method==='POST'?new Response(null,{status:412}):undefined,['HEAD','POST']],
    ['lost ACK',({options})=>{if(options.method==='POST')throw Error('SYNTHETIC_WRITE_UNKNOWN');},['HEAD','POST']],
  ])await t.test(name,async()=>{
    const f=fake({intercept}),input={bytes:previewDisplay(),metadata:previewMetadata()};
    await assert.rejects(f.store.createAcceptedPreview(input));assert.deepEqual(f.calls.map(c=>c.options.method),methods);
    await assert.rejects(f.store.createAcceptedPreview(input),/PREVIEW_CREATE_CLOSED/);assert.equal(f.calls.length,methods.length);
    if(methods.includes('POST')){
      await assert.rejects(f.store.replaceLatest({ifGenerationMatch:'0',headers:LATEST_HEADERS,bytes:input.bytes,
        metadata:{...input.metadata,displaySha256:hash(input.bytes)}}),/PREVIEW_CREATE_CLOSED/);assert.equal(f.calls.length,methods.length);
    }
  });
});
test('preview custom format rejects mixed daily metadata, unregistered fields, duplicate keys and display tampering',async t=>{
  for(const [name,edit] of [
    ['mixed kind',m=>{m.metadata.bundleMetadata='{}';}],
    ['unregistered field',m=>{const p=JSON.parse(m.metadata.previewMetadata);p.artifactGeneration='1';m.metadata.previewMetadata=JSON.stringify(p);}],
    ['duplicate key',m=>{m.metadata.previewMetadata=m.metadata.previewMetadata.replace('"schema":','"schema":"duplicate","schema":');}],
    ['wrong display hash',m=>{m.metadata.displaySha256='f'.repeat(64);}],
  ])await t.test(name,async()=>{
    const f=fake(),bytes=previewDisplay();const m=f.add(LATEST_TARGET.object,'7',bytes,previewCustom(previewMetadata(),bytes));edit(m);
    await assert.rejects(f.store.readLatest());assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
  });
});
test('preview pinned readback rejects changed registration metadata after a correct ACK',async()=>{
  const f=fake(),bytes=previewDisplay(),metadata=previewMetadata(),ack=await f.store.createAcceptedPreview({bytes,metadata});
  const saved=f.records.get(LATEST_TARGET.object+'@'+ack.generation).metadata;
  const changed={...metadata,registrationSha256:'f'.repeat(64)};saved.metadata=previewCustom(changed,bytes);
  await assert.rejects(f.store.readLatestGeneration({generation:ack.generation,sha256:hash(bytes),metadata:{...metadata,displaySha256:hash(bytes)}}),/READBACK_METADATA_MISMATCH/);
});
test('normal weekday publisher replaces verified accepted preview using actual generation and original daily path rules',async()=>{
  const f=fake(),bytes=previewDisplay(),metadata=previewMetadata(),metadataDigest=await previewMetadataSha256(metadata);
  const actualGeneration='7';
  f.add(LATEST_TARGET.object,actualGeneration,bytes,previewCustom(metadata,bytes));
  const next=structuredClone(f.bundle);Object.assign(next.metadata,{dataDate:'2026-10-19',sourceDate:'2026-10-19',
    captureStartedAt:'2026-10-19T12:00:00.000Z',captureEndedAt:'2026-10-19T12:01:00.000Z',completedAt:'2026-10-19T12:02:00.000Z',
    artifactObject:'delivery/2026-10-19/report.html',receiptObject:'delivery/2026-10-19/receipt.json'});
  f.add(next.metadata.artifactObject,next.metadata.artifactGeneration,next.html);f.add(next.metadata.receiptObject,next.metadata.receiptGeneration,next.receipt);
  const phases=[];
  const p=createOwnerLatestPublisher({io:f.store,ownerBinding:OWNER,now:()=>Date.parse('2026-10-19T13:00:00.000Z'),prepareDisplay:bytes=>new Uint8Array(bytes),
    verifyProtectedReceipt:({metadata:m,phase})=>{phases.push(phase);return {scope:m.scope,ownerBinding:m.ownerBinding,
      sourceIdentitySha256:m.sourceIdentitySha256,artifactSha256:m.artifactSha256,receiptSha256:m.receiptSha256,policyRevision:'c'.repeat(64),financialStatus:m.financialStatus};},
    verifyProtectedPreview:({metadata:m,displayBytes,phase})=>{assert.equal(phase,'historical-authenticity');return {
      schema:'xuan.owner-accepted-preview-proof.v1',scope:m.scope,ownerBinding:m.ownerBinding,sourceIdentitySha256:m.sourceIdentitySha256,
      registrationId:m.registrationId,registrationSha256:m.registrationSha256,registrationPolicyCommit:m.registrationPolicyCommit,
      displaySha256:hash(displayBytes),metadataSha256:metadataDigest};}});
  assert.equal((await p.publish(next)).status,'published-verified');assert.deepEqual(phases,['candidate-admission']);
  const posts=f.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);
  assert.equal(new URL(posts[0].url).searchParams.get('ifGenerationMatch'),actualGeneration);
  const current=await f.store.readLatest();assert.equal(Object.hasOwn(current,'kind'),false);
  assert.deepEqual(current.bundle.metadata,next.metadata);
});
