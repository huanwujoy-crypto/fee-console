import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {types as utilTypes} from 'node:util';
import {safeErrorOrigin} from './report.mjs';
import {decodeOwnerSafeDiagnostics,OWNER_SAFE_ERROR_CODES} from './owner_sdk_transport.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describeOwnerBoundary,evaluateOwnerBoundary,renderOwnerPhoneCanary,validateOwnerPhoneCanary,
  validateOwnerCanaryMetadata,validateOwnerBoundaryWindow,validateOwnerPreflightAge,FULL_PREFLIGHT_TTL_MS,
  MAX_CANARY_BYTES,CANARY_TARGET,createOwnerPreflightLease,validateRegisteredOwnerCanary,
  readRegisteredOwnerCanary,createReplacementObservation} from './owner_preview_access.mjs';
import {LATEST_TARGET,LATEST_HEADERS,OWNER_SCOPE,ownerJsonMediaHeadersMatch} from './owner_latest.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256} from './owner_latest_admission.mjs';
import {validatePreviewReplacementRegistration,previewReplacementRegistrationText,acceptedPreviewRegistrationText} from './owner_accepted_preview.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const NOW=Date.parse('2026-10-17T12:00:00.000Z');
const approved=JSON.parse(fs.readFileSync(new URL('../../security/xuan-owner-approved-audience.json',import.meta.url),'utf8'));
function fixture(){
  const owner='user:synthetic-owner',members=[owner,...Array.from({length:6},(_,i)=>'serviceAccount:synthetic-reader-'+i)];
  const names=approved.roleDefinitions.map(x=>x.name),getRole='roles/storage.legacyObjectOwner',createRole='roles/storage.legacyBucketOwner';
  const roleDefinitions=names.map(name=>({name,stage:'GA',includedPermissions:name===getRole?['storage.objects.get']:
    name===createRole?['storage.objects.create']:['synthetic.unrelatedPermission']}));
  const boundary={schema:'xuan.owner-sdk-live-boundary.v1',actorIdentifier:'SYNTHETIC_OWNER',
    bucketMetadata:{name:LATEST_TARGET.bucket,projectNumber:'123456789012',location:'ASIA-EAST2',storageClass:'STANDARD',
      iamConfiguration:{uniformBucketLevelAccess:{enabled:true},publicAccessPrevention:'enforced'}},
    projectMetadata:{projectId:'family-portfolio-gateway',projectNumber:'123456789012'},
    bucketIam:{bindings:[{role:getRole,members},{role:createRole,members:[owner]}]},
    projectIam:{version:3,bindings:names.filter(n=>![getRole,createRole].includes(n)).map(role=>({role,members:[owner]}))},
    roleDefinitions,bucketTestPermissions:{permissions:['storage.objects.get','storage.objects.create']},
    startedAt:'2026-10-17T11:59:50.000Z',completedAt:'2026-10-17T11:59:59.000Z'};
  const registry=describeOwnerBoundary(boundary,{ownerPrincipalSha256:hash(owner),approvedReaderPrincipalSha256:members.map(hash)});
  return {boundary,registry};
}
const fields=()=>({uuid:'11111111-2222-4333-8444-555555555555',createdAt:'2026-10-17T12:00:00.000Z',candidateSha256:'a'.repeat(64)});
test('replacement requires both readonly delete probe and effective owner delete while audience remains identical',()=>{
  const f=fixture();assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry,{requireDeletePermission:true}),/DELETE_PERMISSION/);
  f.boundary.bucketTestPermissions.permissions.push('storage.objects.delete');
  assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry,{requireDeletePermission:true}),/OWNER_DELETE_PERMISSION/);
  f.boundary.roleDefinitions.find(r=>r.name==='roles/storage.legacyBucketOwner').includedPermissions.push('storage.objects.delete');
  const registry=describeOwnerBoundary(f.boundary,{ownerPrincipalSha256:f.registry.ownerPrincipalSha256,approvedReaderPrincipalSha256:f.registry.approvedReaderPrincipalSha256});
  assert.equal(evaluateOwnerBoundary(f.boundary,registry,{requireDeletePermission:true}).readerCount,7);
  f.boundary.bucketIam.bindings[0].members.push('user:synthetic-intruder');assert.throws(()=>evaluateOwnerBoundary(f.boundary,registry,{requireDeletePermission:true}));
});
test('native observation is explicitly an attestation: fresh exact old canary, revision-bound nonce, one consume only',()=>{
  const pin={...fields(),generation:'900719925474099312345',sha256:hash(renderOwnerPhoneCanary(fields()))};let time=NOW;
  const fresh=()=>createReplacementObservation({revisionSha256:'b'.repeat(64),candidateSha256:'c'.repeat(64),pin,now:()=>time,randomUUID:()=> '00000000-0000-4000-8000-000000000000'});
  const o=fresh(),request=o.begin();assert.equal(request.oldCanaryPin.candidateSha256,'a'.repeat(64));assert.equal(request.candidateSha256,'c'.repeat(64));
  const attestation={nonce:request.nonce,observedAt:new Date(NOW).toISOString(),...fields()};
  assert.equal(o.attest(attestation).status,'trusted-native-ui-attested');o.consume();assert.throws(()=>o.consume(),/OBSERVATION_REQUIRED/);
  for(const edit of [v=>{v.nonce='11111111-2222-4333-8444-555555555555';},v=>{v.observedAt=new Date(NOW+1).toISOString();},v=>{v.candidateSha256='c'.repeat(64);},v=>{v.approved=true;},v=>{time=NOW+60001;},v=>{time=NOW-1;}]){
    time=NOW;const bad=fresh(),r=bad.begin(),v={...attestation,nonce:r.nonce};edit(v);assert.throws(()=>bad.attest(v));assert.throws(()=>bad.consume());
  }
  time=NOW;const missing=fresh();missing.begin();assert.throws(()=>missing.consume());const closed=fresh();closed.begin();closed.close();assert.throws(()=>closed.attest(attestation));
});
test('exact synthetic configured audience and all seventeen storage-role definitions pass',()=>{
  const f=fixture(),result=evaluateOwnerBoundary(f.boundary,f.registry);assert.equal(result.readerCount,7);assert.equal(result.roles.size,17);
  assert.equal(result.boundarySha256,f.registry.boundarySha256);assert.equal(f.registry.rolePermissionScope,'storage.*');
  assert.equal(Object.hasOwn(f.registry,'projectNumber'),false);
});
test('approved true, unknown expected fields and tampered registry hashes cannot grant access',()=>{
  const f=fixture();assert.throws(()=>evaluateOwnerBoundary(f.boundary,{approved:true}));
  for(const edit of [r=>{r.approved=true;},r=>{r.boundarySha256='f'.repeat(64);},r=>{r.roleDefinitions.pop();}]){
    const r=structuredClone(f.registry);edit(r);assert.throws(()=>evaluateOwnerBoundary(f.boundary,r));
  }
});
test('actor, any IAM binding/condition, project parent, bucket isolation or effective create drift fail',async t=>{
  for(const [name,edit] of [
    ['actor',b=>{b.actorIdentifier='SYNTHETIC_DIFFERENT_OWNER';}],
    ['reader',b=>{b.bucketIam.bindings[0].members.push('serviceAccount:synthetic-new-reader');}],
    ['condition',b=>{b.bucketIam.bindings[0].condition={expression:'true'};}],
    ['parent',b=>{b.projectMetadata.parent={type:'organization',id:'synthetic'};}],
    ['project number',b=>{b.projectMetadata.projectNumber='999999999999';}],
    ['uniform access',b=>{b.bucketMetadata.iamConfiguration.uniformBucketLevelAccess.enabled=false;}],
    ['public prevention',b=>{b.bucketMetadata.iamConfiguration.publicAccessPrevention='inherited';}],
    ['permissions',b=>{b.bucketTestPermissions.permissions=['storage.objects.get'];}],
    ['extra role',b=>{b.projectIam.bindings.push({role:'roles/storage.objectViewer',members:['user:synthetic-owner']});}],
  ])await t.test(name,()=>{const f=fixture();edit(f.boundary);assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry));});
});
test('unrelated role permissions may change; any storage permission, deletion or stage change is blocked',()=>{
  const f=fixture();f.boundary.roleDefinitions[0].includedPermissions.push('unrelated.newPermission','synthetic.vendor.com/clusters.read');
  assert.equal(evaluateOwnerBoundary(f.boundary,f.registry).readerCount,7);
  for(const edit of [r=>{r.includedPermissions.push('storage.objects.delete');},r=>{r.deleted=true;},r=>{r.stage='DISABLED';}]){
    const g=fixture();edit(g.boundary.roleDefinitions[0]);assert.throws(()=>evaluateOwnerBoundary(g.boundary,g.registry));
  }
});
test('policy order and etags do not change semantic boundary; missing role definitions do',()=>{
  const f=fixture();f.boundary.bucketIam.bindings.reverse();f.boundary.bucketIam.etag='synthetic-new-etag';
  f.boundary.bucketIam.bindings.forEach(b=>b.members.reverse());assert.equal(evaluateOwnerBoundary(f.boundary,f.registry).readerCount,7);
  f.boundary.roleDefinitions.pop();assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry));
});
test('user principal case is canonicalized while raw SDK actor identity remains exactly pinned',()=>{
  const f=fixture();for(const p of [f.boundary.bucketIam,f.boundary.projectIam])for(const b of p.bindings)
    b.members=b.members.map(m=>m.startsWith('user:')?'user:'+m.slice(5).toUpperCase():m);
  assert.equal(evaluateOwnerBoundary(f.boundary,f.registry).readerCount,7);
  f.boundary.actorIdentifier=f.boundary.actorIdentifier.toLowerCase();assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry),/BOUNDARY_CHANGED/);
});
test('policy version projections do not erase or change the exact bound IAM conditions',()=>{
  const f=fixture();f.boundary.bucketIam.bindings[0].condition={expression:"resource.name.startsWith('projects/_/buckets/"+LATEST_TARGET.bucket+"/objects/delivery/')",title:'synthetic_delivery'};
  const r=describeOwnerBoundary(f.boundary,{ownerPrincipalSha256:f.registry.ownerPrincipalSha256,approvedReaderPrincipalSha256:f.registry.approvedReaderPrincipalSha256});
  f.boundary.bucketIam.version=3;assert.equal(evaluateOwnerBoundary(f.boundary,r).readerCount,7);
  f.boundary.bucketIam.bindings[0].condition.expression="resource.name == 'different'";assert.throws(()=>evaluateOwnerBoundary(f.boundary,r));
});
test('native GCS policy kind and exact bucket resource representation match the CLI projection',()=>{
  const f=fixture();Object.assign(f.boundary.bucketIam,{kind:'storage#policy',resourceId:'projects/_/buckets/'+LATEST_TARGET.bucket});
  assert.equal(evaluateOwnerBoundary(f.boundary,f.registry).readerCount,7);
});
test('native policy representation cannot hide wrong resources, kinds, partial fields or unknown authorization fields',async t=>{
  for(const [name,edit] of [
    ['wrong kind',p=>{p.kind='storage#different';p.resourceId='projects/_/buckets/'+LATEST_TARGET.bucket;}],
    ['wrong bucket',p=>{p.kind='storage#policy';p.resourceId='projects/_/buckets/another-bucket';}],
    ['kind only',p=>{p.kind='storage#policy';}],
    ['resource only',p=>{p.resourceId='projects/_/buckets/'+LATEST_TARGET.bucket;}],
    ['unknown policy field',p=>{p.auditConfigs=[];}],
    ['unknown binding field',p=>{p.bindings[0].approved=true;}],
    ['invalid etag',p=>{p.etag={unrecognized:true};}],
  ])await t.test(name,()=>{const f=fixture();edit(f.boundary.bucketIam);assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry));});
  const f=fixture();Object.assign(f.boundary.projectIam,{kind:'storage#policy',resourceId:'projects/_/buckets/'+LATEST_TARGET.bucket});
  assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry));
});
test('quick current-policy verification reuses only previously checked storage role semantics',()=>{
  const f=fixture(),checked=evaluateOwnerBoundary(f.boundary,f.registry);f.boundary.roleDefinitions=[];
  assert.equal(evaluateOwnerBoundary(f.boundary,f.registry,{cachedRoles:checked.roles}).readerCount,7);
  f.boundary.projectIam.bindings[0].members=['serviceAccount:synthetic-drift'];
  assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry,{cachedRoles:checked.roles}));
});
test('unknown conditions, unresolved groups and absence of owner get/create are rejected even by pure descriptors',()=>{
  for(const edit of [b=>{b.bucketIam.bindings[0].condition={expression:'request.time < timestamp("future")'};},
    b=>{b.bucketIam.bindings[0].members[1]='group:synthetic-group';},
    b=>{b.roleDefinitions.find(r=>r.name==='roles/storage.legacyBucketOwner').includedPermissions=[];}]){
    const f=fixture();edit(f.boundary);
    const r=describeOwnerBoundary(f.boundary,{ownerPrincipalSha256:f.registry.ownerPrincipalSha256,approvedReaderPrincipalSha256:f.registry.approvedReaderPrincipalSha256});
    assert.throws(()=>evaluateOwnerBoundary(f.boundary,r));
  }
});
test('full preflight is sixty seconds; future, stale and long boundary windows fail',()=>{
  const f=fixture();validateOwnerBoundaryWindow(f.boundary,NOW);validateOwnerPreflightAge(NOW,NOW+FULL_PREFLIGHT_TTL_MS);
  assert.throws(()=>validateOwnerPreflightAge(NOW,NOW+FULL_PREFLIGHT_TTL_MS+1));assert.throws(()=>validateOwnerPreflightAge(NOW,NOW-1));
  for(const edit of [b=>{b.completedAt='2026-10-17T12:00:01.000Z';},b=>{b.startedAt='2026-10-17T11:00:00.000Z';},b=>{b.completedAt='2026-10-17T11:59:54.000Z';}]){
    const b=structuredClone(f.boundary);edit(b);assert.throws(()=>validateOwnerBoundaryWindow(b,NOW));
  }
});
test('failed role refresh invalidates previous role cache and previously minted POST admission',()=>{
  const f=fixture(),lease=createOwnerPreflightLease();lease.install(evaluateOwnerBoundary(f.boundary,f.registry),NOW);lease.mintAdmission(NOW+1000);
  lease.invalidate();f.boundary.roleDefinitions[0].includedPermissions.push('storage.objects.delete');
  assert.throws(()=>evaluateOwnerBoundary(f.boundary,f.registry),/ROLE_CHANGED/);
  assert.throws(()=>lease.current(NOW+2000),/PREFLIGHT_EXPIRED/);
  assert.throws(()=>lease.mintAdmission(NOW+2000),/PREFLIGHT_EXPIRED/);
  assert.throws(()=>lease.consumeAdmission(NOW+2000),/PREFLIGHT_EXPIRED/);
});
test('POST admission is single-use and cannot extend full preflight TTL across a slow canary GET',()=>{
  const f=fixture(),lease=createOwnerPreflightLease();lease.install(evaluateOwnerBoundary(f.boundary,f.registry),NOW);
  lease.mintAdmission(NOW+1000);lease.consumeAdmission(NOW+1001);assert.throws(()=>lease.consumeAdmission(NOW+1002),/FINANCIAL_ADMISSION_REQUIRED/);
  lease.mintAdmission(NOW+59000);assert.throws(()=>lease.consumeAdmission(NOW+61000),/PREFLIGHT_EXPIRED/);
  assert.throws(()=>lease.mintAdmission(NOW+61000),/PREFLIGHT_EXPIRED/);
});
test('canary is deterministic fixed nonfinancial HTML with only UUID, actual timestamp and candidate hash',()=>{
  const bytes=renderOwnerPhoneCanary(fields()),html=new TextDecoder().decode(bytes);assert.equal(validateOwnerPhoneCanary(bytes,fields()),hash(bytes));
  assert.ok(bytes.length<MAX_CANARY_BYTES);assert.ok(html.includes('Private delivery check'));
  assert.equal(/@|account|portfolio|order|cash|amount|https?:|<script|<form|<iframe|href=|src=/i.test(html),false);
  assert.equal(html.endsWith('\n'),false);assert.equal(CANARY_TARGET.object,'delivery/owner-phone-canary-v1.html');
});
test('canary rejects caller HTML, financial substitutions, invalid UUID/date/hash and tampered byte content',()=>{
  for(const change of [f=>{f.uuid='not-a-uuid';},f=>{f.createdAt='2026-02-30T00:00:00.000Z';},f=>{f.candidateSha256='bad';}]){
    const f=fields();change(f);assert.throws(()=>renderOwnerPhoneCanary(f));
  }
  const bytes=renderOwnerPhoneCanary(fields());bytes[0]^=1;assert.throws(()=>validateOwnerPhoneCanary(bytes,fields()));
  assert.throws(()=>validateOwnerPhoneCanary(new TextEncoder().encode('<p>cash 123</p>'),fields()));
});
test('independent canary metadata binding checks target, generation, private headers, size and every registered field',()=>{
  const f=fields(),bytes=renderOwnerPhoneCanary(f),pin={...f,generation:'91',sha256:hash(bytes)};
  const metadata={bucket:CANARY_TARGET.bucket,name:CANARY_TARGET.object,generation:'91',size:String(bytes.length),...LATEST_HEADERS,
    metadata:{schema:'xuan.owner-phone-canary.v1',...f,canarySha256:pin.sha256}};validateOwnerCanaryMetadata(metadata,pin);
  for(const edit of [m=>{m.name=LATEST_TARGET.object;},m=>{m.generation='92';},m=>{m.cacheControl='public';},m=>{m.size='99999';},m=>{m.metadata.candidateSha256='f'.repeat(64);},m=>{m.metadata.approved=true;}]){
    const m=structuredClone(metadata);edit(m);assert.throws(()=>validateOwnerCanaryMetadata(m,pin));
  }
});
test('production source has no injected SDK, expected audience, canary receipt, HTML or approval override',()=>{
  const source=fs.readFileSync(new URL('./owner_preview_access.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('export async function createOwnerPreviewAccess(){'));
  assert.ok(source.indexOf('await requireProtectedOwnerCheckout();')<source.indexOf('const sdk=createOwnerSdkTransport();'));
  assert.ok(source.includes('async createCanary(){'));assert.ok(source.includes('lease.consumeAdmission(Date.now()); // Every possible write consumes admission.'));
  assert.equal(/approved\s*[:=]\s*true|process\.env|print-access-token|setIamPolicy|signIn|login\(/.test(source),false);
  const serialized=JSON.stringify(approved);assert.equal(/@|"projectNumber"/.test(serialized),false);
});

// Native-shaped synthetic responses exercise the verifier's real stream, URL,
// metadata and current-entry checks. No SDK or HTTP implementation is involved.
function registeredCanaryFixture({editMetadata,editMedia,editHead,onRequest}={}){
  const f=fields(),bytes=renderOwnerPhoneCanary(f),pin={...f,generation:'91',sha256:hash(bytes)};
  const registration={schema:'xuan.owner-registered-canary.v1',target:{...CANARY_TARGET},pin};
  const calls=[],metadata={bucket:CANARY_TARGET.bucket,name:CANARY_TARGET.object,generation:pin.generation,
    size:String(bytes.length),...LATEST_HEADERS,metadata:{schema:'xuan.owner-phone-canary.v1',...f,canarySha256:pin.sha256}};
  const base='https://storage.googleapis.com/storage/v1/b/'+CANARY_TARGET.bucket+'/o/'+encodeURIComponent(CANARY_TARGET.object);
  const wire={'content-type':LATEST_HEADERS.contentType,'content-disposition':'attachment',
    'cache-control':'no-cache, no-store, max-age=0, must-revalidate','content-length':String(bytes.length),'x-goog-generation':pin.generation};
  const requestCanary=async options=>{
    const {method='GET',generation,media=true}=options;
    assert.ok(['GET','HEAD'].includes(method),'registered-canary reads must never write');
    if(method==='GET')assert.equal(generation,pin.generation,'both GETs must pin the registered generation');
    else assert.equal(generation,undefined,'the last HEAD checks the current browser entry');
    calls.push({method,generation,media});await onRequest?.(options,calls.length);
    const url=new URL(base);if(generation!==undefined)url.searchParams.set('generation',generation);if(media)url.searchParams.set('alt','media');
    const value={status:200,url:url.href,redirected:false,headers:{...wire},body:new Uint8Array(bytes)};
    if(method==='HEAD'){value.body=null;editHead?.(value);}
    else if(!media){const m=structuredClone(metadata);editMetadata?.(m);value.body=JSON.stringify(m);
      value.headers={'content-type':'application/json; charset=utf-8'};}
    else editMedia?.(value);
    const response=new Response(value.body,{status:value.status,headers:value.headers});
    Object.defineProperty(response,'url',{value:value.url});Object.defineProperty(response,'redirected',{value:value.redirected});return response;
  };
  return {registration,pin,bytes,calls,requestCanary};
}
test('registered canary verifies native metadata and bytes before current HEAD, without any write',async()=>{
  const f=registeredCanaryFixture(),pin=await readRegisteredOwnerCanary({requestCanary:f.requestCanary,
    registration:f.registration,candidateSha256:fields().candidateSha256});
  assert.deepEqual(pin,f.pin);assert.notEqual(pin,f.registration.pin);
  assert.deepEqual(f.calls.map(x=>[x.method,x.media]),[['GET',false],['GET',true],['HEAD',true]]);
  pin.generation='92';assert.equal(f.registration.pin.generation,'91');
});
test('registered canary cannot select a caller target, candidate, body or approval flag',async t=>{
  for(const [name,edit] of [
    ['approval JSON',r=>{r.approved=true;}],['other object',r=>{r.target.object=LATEST_TARGET.object;}],
    ['other bucket',r=>{r.target.bucket='synthetic-other-bucket';}],['candidate',r=>{r.pin.candidateSha256='b'.repeat(64);}],
    ['body hash',r=>{r.pin.sha256='f'.repeat(64);}],['generation number',r=>{r.pin.generation=91;}],
    ['zero generation',r=>{r.pin.generation='0';}],['caller HTML',r=>{r.pin.html='<p>synthetic</p>';}],
  ])await t.test(name,async()=>{
    const f=registeredCanaryFixture();edit(f.registration);
    assert.throws(()=>validateRegisteredOwnerCanary(f.registration,fields().candidateSha256));
    await assert.rejects(readRegisteredOwnerCanary({requestCanary:f.requestCanary,registration:f.registration,
      candidateSha256:fields().candidateSha256}));assert.equal(f.calls.length,0);
  });
});
test('registered canary rejects stored metadata drift and corrupt media before accepting a current entry',async t=>{
  const cases=[
    ['metadata generation',{editMetadata:m=>{m.generation='92';}}],
    ['metadata disposition',{editMetadata:m=>{m.contentDisposition='attachment';}}],
    ['metadata cache',{editMetadata:m=>{m.cacheControl='public';}}],
    ['extra custom field',{editMetadata:m=>{m.metadata.approved=true;}}],
    ['body tampering',{editMedia:r=>{r.body[0]^=1;}}],
    ['media generation',{editMedia:r=>{r.headers['x-goog-generation']='92';}}],
    ['media length missing',{editMedia:r=>{delete r.headers['content-length'];}}],
    ['media public cache',{editMedia:r=>{r.headers['cache-control']='public, max-age=600';}}],
    ['media encoding',{editMedia:r=>{r.headers['content-encoding']='gzip';}}],
    ['redirected response',{editMedia:r=>{r.redirected=true;}}],
  ];
  for(const [name,options] of cases)await t.test(name,async()=>{
    const f=registeredCanaryFixture(options);await assert.rejects(readRegisteredOwnerCanary({requestCanary:f.requestCanary,
      registration:f.registration,candidateSha256:fields().candidateSha256}));
    assert.equal(f.calls.some(x=>x.method==='HEAD'),false);
  });
});
test('an intact historical generation cannot hide changed, missing or unsafe current browser content',async t=>{
  for(const [name,editHead] of [
    ['replacement',r=>{r.headers['x-goog-generation']='92';}],['missing generation',r=>{delete r.headers['x-goog-generation'];}],
    ['not found',r=>{r.status=404;}],['forbidden',r=>{r.status=403;}],['redirect',r=>{r.redirected=true;}],
    ['different size',r=>{r.headers['content-length']='1';}],['public cache',r=>{r.headers['cache-control']='public';}],
    ['missing disposition',r=>{delete r.headers['content-disposition'];}],['encoding',r=>{r.headers['content-encoding']='gzip';}],
  ])await t.test(name,async()=>{
    const f=registeredCanaryFixture({editHead});await assert.rejects(readRegisteredOwnerCanary({requestCanary:f.requestCanary,
      registration:f.registration,candidateSha256:fields().candidateSha256}));
    assert.deepEqual(f.calls.map(x=>x.method),['GET','GET','HEAD']);
  });
});
test('registered-canary cancellation before reading or at the final HEAD never returns a pin',async()=>{
  const a=new AbortController();a.abort();const first=registeredCanaryFixture();
  await assert.rejects(readRegisteredOwnerCanary({requestCanary:first.requestCanary,registration:first.registration,
    candidateSha256:fields().candidateSha256,signal:a.signal}));assert.equal(first.calls.length,0);
  const b=new AbortController(),last=registeredCanaryFixture({onRequest:options=>{if(options.method==='HEAD')b.abort();}});
  await assert.rejects(readRegisteredOwnerCanary({requestCanary:last.requestCanary,registration:last.registration,
    candidateSha256:fields().candidateSha256,signal:b.signal}),/ABORTED/);assert.equal(last.calls.length,3);
});

const FACTORY_TEST='production registered-canary capability enforces real factory state with synthetic dependencies';
test(FACTORY_TEST,async t=>{
  // Run this same test in a fresh Node child when VM modules are not enabled.
  // No source rewrite or production dependency-injection hook is introduced.
  if(typeof vm.SourceTextModule!=='function'){
    const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--experimental-vm-modules','--test','--test-name-pattern','^'+FACTORY_TEST,fileURLToPath(import.meta.url)],
      {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,shell:false,env:childEnv});
    assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
    assert.match(child.stdout,/SYNTHETIC_FACTORY_SCENARIOS_COMPLETED:18/);return;
  }
  let active={now:NOW,abort:new AbortController()},completedScenarios=0;
  t.mock.method(Date,'now',()=>active.now);
  t.mock.method(AbortSignal,'timeout',()=>active.abort.signal);
  t.mock.method(globalThis,'fetch',()=>assert.fail('factory tests must never perform network I/O'));
  async function harness(options={}){
    const f=fixture(),canary=registeredCanaryFixture(options),events=options.events??[],control={now:NOW,abort:new AbortController(),
      boundaryEdit:null,holdBoundary:null,...options};active=control;
    if(options.replacing){f.boundary.bucketTestPermissions.permissions.push('storage.objects.delete');
      f.boundary.roleDefinitions.find(r=>r.name==='roles/storage.legacyBucketOwner').includedPermissions.push('storage.objects.delete');
      f.registry=describeOwnerBoundary(f.boundary,{ownerPrincipalSha256:f.registry.ownerPrincipalSha256,approvedReaderPrincipalSha256:f.registry.approvedReaderPrincipalSha256});}
    const source=fs.readFileSync(new URL('./owner_preview_access.mjs',import.meta.url),'utf8');
    const sdk={
      async readLiveBoundary({includeRoleDefinitions}){
        events.push(includeRoleDefinitions?'full-boundary':'quick-boundary');if(control.boundaryError)throw control.boundaryError;await control.holdBoundary?.();
        const boundary=structuredClone(f.boundary);boundary.startedAt=new Date(control.now-10).toISOString();
        boundary.completedAt=new Date(control.now).toISOString();if(!includeRoleDefinitions)boundary.roleDefinitions=[];
        control.boundaryEdit?.(boundary,includeRoleDefinitions);return boundary;
      },
      async requestCanary(value){events.push('canary-'+value.method);if(control.canaryError)throw control.canaryError;return canary.requestCanary(value);},
      async createCanary(){events.push('canary-POST');throw Object.assign(Error('synthetic unknown write'),{safeCode:'REQUEST_OUTCOME_UNKNOWN'});},
      async request(){events.push('financial-POST');return new Response(null,{status:200});},
      async requestPreviewReplacement(url,options,pins,lease){events.push('replacement-POST');assert.equal(pins.previousGeneration,'900719925474099312345');
        assert.equal(lease.admissionExpiresAt,control.now+5000);if(control.postError)throw Error('SYNTHETIC_WRITE_OUTCOME_UNKNOWN');return new Response(null,{status:200});},
      close(){events.push('close');if(control.closeError)throw control.closeError;},
    };
    const files={
      'xuan-owner-approved-audience.json':f.registry,
      'xuan-owner-registered-canary.json':canary.registration,
      'xuan-owner-accepted-preview.json':{displaySha256:fields().candidateSha256},
    };
    if(options.replacing){const registration={schema:'xuan.owner-accepted-preview-registration.v1',registrationId:'synthetic-saturday',scope:OWNER_SCOPE,
      ownerBinding:OWNER_BINDING,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,dataDate:'2026-10-17',sourceDate:'2026-10-16',captureStartedAt:'2026-10-17T06:00:00.000Z',
      captureEndedAt:'2026-10-17T06:02:00.000Z',completedAt:'2026-10-17T06:03:00.000Z',ordersCaptureStartedAt:'2026-10-17T06:00:01.000Z',ordersCaptureEndedAt:'2026-10-17T06:00:15.000Z',
      sourceHead:'e'.repeat(40),artifactSha256:'e'.repeat(64),modelSha256:'e'.repeat(64),sourceManifestSha256:'e'.repeat(64),sourceManifestContentSha256:'e'.repeat(64),
      displaySha256:fields().candidateSha256,financialStatus:'partial',unknownFields:['cash','prices']};
      files['xuan-owner-accepted-preview.json']=registration;
      files['xuan-owner-preview-replacement.json']={schema:'xuan.owner-preview-replacement.v1',target:{...LATEST_TARGET},
        previousRegistrationSha256:hash(acceptedPreviewRegistrationText(registration)),previousDisplaySha256:registration.displaySha256,
        canaryRegistrationSha256:hash(JSON.stringify(canary.registration)),registration:{...registration,displaySha256:'c'.repeat(64)}};
    }
    const dependencies={
      'node:crypto':{default:crypto},
      'node:util':{types:utilTypes},
      './report.mjs':{safeErrorOrigin},
      'node:fs':{default:{readFileSync:url=>{const name=new URL(url).pathname.split('/').pop();
        assert.ok(Object.hasOwn(files,name),'unexpected filesystem access: '+name);
        return name==='xuan-owner-preview-replacement.json'?previewReplacementRegistrationText(files[name]):name==='xuan-owner-accepted-preview.json'&&options.replacing?acceptedPreviewRegistrationText(files[name]):JSON.stringify(files[name]);}}},
      '../../scripts/xuan-ib-decision-menu.mjs':{parseDecisionJson:value=>JSON.parse(value)},
      './owner_latest.mjs':{LATEST_TARGET,LATEST_HEADERS,ownerJsonMediaHeadersMatch},
      './owner_latest_delivery.mjs':{requireProtectedOwnerCheckout:async()=>{events.push('protected');
        if(control.protectedError)throw Error('SYNTHETIC_PROTECTED_CHECKOUT_REJECTED');}},
      './owner_sdk_transport.mjs':{createOwnerSdkTransport:()=>{events.push('sdk-created');return sdk;},decodeOwnerSafeDiagnostics,OWNER_SAFE_ERROR_CODES},
      './owner_accepted_preview.mjs':{validatePreviewReplacementRegistration,previewReplacementRegistrationText,acceptedPreviewRegistrationText},
    };
    const module=new vm.SourceTextModule(source,{initializeImportMeta:meta=>{meta.url=new URL('./owner_preview_access.mjs',import.meta.url).href;}});
    await module.link(specifier=>{assert.ok(Object.hasOwn(dependencies,specifier),'unexpected production import: '+specifier);
      const values=dependencies[specifier];return new vm.SyntheticModule(Object.keys(values),function(){
        for(const [name,value] of Object.entries(values))this.setExport(name,value);
      });});await module.evaluate();
    const access=options.storage?await module.namespace.createOwnerPreviewReplacementStorageAccess():await (options.replacing?module.namespace.createOwnerPreviewReplacementAccess:module.namespace.createOwnerPreviewAccess)({pin:{generation:'caller-override'},approved:true});
    return {access,events,control,canary,revision:files['xuan-owner-preview-replacement.json'],storageFactory:module.namespace.createOwnerPreviewReplacementStorageAccess};
  }
  const post=access=>access.request('https://storage.googleapis.com/upload/storage/v1/b/'+LATEST_TARGET.bucket+'/o?uploadType=multipart&ifGenerationMatch=0',{method:'POST'});
  const verify=access=>access.verifyDestinationAccess({target:{...LATEST_TARGET},operation:'create-accepted-preview'});
  const scenario=(name,run)=>t.test(name,async st=>{await run(st);completedScenarios++;});
  await scenario('protected checkout fails before SDK creation; invalid full boundary closes its transport',async()=>{
    const first=[];await assert.rejects(harness({events:first,protectedError:true}),/SYNTHETIC_PROTECTED_CHECKOUT_REJECTED/);
    assert.deepEqual(first,['protected']);
    const second=[];await assert.rejects(harness({events:second,boundaryEdit:b=>{b.actorIdentifier='SYNTHETIC_DIFFERENT_OWNER';}}),/BOUNDARY_CHANGED/);
    assert.deepEqual(second,['protected','sdk-created','full-boundary','close']);
  });
  await scenario('adoption only reads; a returned descriptor cannot mint admission or replace the fixed pin',async()=>{
    const h=await harness();assert.deepEqual(h.events,['protected','sdk-created','full-boundary']);
    const adopted=await h.access.verifyRegisteredCanary({pin:{generation:'caller-override'},approved:true});
    assert.equal(adopted.status,'existing-verified');assert.equal(adopted.pin.generation,'91');
    assert.equal(h.events.filter(x=>x==='full-boundary').length,1);assert.ok(h.events.includes('quick-boundary'));
    assert.deepEqual(h.canary.calls.map(x=>x.method),['GET','GET','HEAD']);
    assert.throws(()=>post(h.access),/FINANCIAL_ADMISSION_REQUIRED/);assert.equal(h.events.includes('financial-POST'),false);
    adopted.pin.generation='999';await verify(h.access);await post(h.access);
    assert.equal(h.events.filter(x=>x==='financial-POST').length,1);
    assert.throws(()=>post(h.access),/FINANCIAL_ADMISSION_REQUIRED/);
    await assert.rejects(h.access.createCanary(),/CANARY_CLOSED/);await assert.rejects(h.access.verifyRegisteredCanary(),/CANARY_CLOSED/);
    h.access.close();
  });
  await scenario('changed current entry during later access clears any previously minted financial admission',async()=>{
    let replaced=false;const h=await harness({editHead:r=>{if(replaced)r.headers['x-goog-generation']='92';}});
    assert.equal((await h.access.verifyRegisteredCanary()).status,'existing-verified');await verify(h.access);replaced=true;
    await assert.rejects(verify(h.access),/CANARY_CURRENT/);assert.throws(()=>post(h.access),/FINANCIAL_ADMISSION_REQUIRED/);
    assert.equal(h.events.includes('financial-POST'),false);h.access.close();
  });
  await scenario('policy drift, TTL expiry, abort and close cannot install a partly verified pin',async st=>{
    for(const mode of ['policy','ttl','abort','close'])await st.test(mode,async()=>{
      let h;h=await harness({onRequest:options=>{if(options.method==='HEAD'){
        if(mode==='ttl')h.control.now+=FULL_PREFLIGHT_TTL_MS+1;
        if(mode==='abort')h.control.abort.abort();if(mode==='close')h.access.close();
      }}});
      if(mode==='policy')h.control.boundaryEdit=b=>{b.bucketIam.bindings[0].members.push('serviceAccount:synthetic-new-reader');};
      const result=await h.access.verifyRegisteredCanary();assert.equal(result.status,'blocked');
      assert.ok(h.events.includes('close'));assert.throws(()=>post(h.access),/SESSION_CLOSED/);
      await assert.rejects(h.access.verifyRegisteredCanary(),/SESSION_CLOSED/);
      await assert.rejects(h.access.refreshPreflight(),/SESSION_CLOSED/);
      assert.equal(h.events.includes('financial-POST'),false);assert.equal(h.events.includes('canary-POST'),false);
    });
  });
  await scenario('existing canary on original create closes the session without writing or falling back to adoption',async()=>{
    const h=await harness(),result=await h.access.createCanary();assert.equal(result.code,'CANARY_EXISTS');
    assert.equal(result.status,'blocked');assert.equal(h.events.includes('canary-POST'),false);
    await assert.rejects(h.access.verifyRegisteredCanary(),/SESSION_CLOSED/);assert.throws(()=>post(h.access),/SESSION_CLOSED/);
  });
  await scenario('an uncertain create cannot be adopted or posted again in its closed session',async()=>{
    const h=await harness({editHead:r=>{r.status=404;}}),result=await h.access.createCanary();
    assert.equal(result.status,'unknown');assert.equal(result.stage,'write');
    assert.equal(h.events.filter(x=>x==='canary-POST').length,1);
    await assert.rejects(h.access.verifyRegisteredCanary(),/SESSION_CLOSED/);
    await assert.rejects(h.access.createCanary(),/SESSION_CLOSED/);assert.throws(()=>post(h.access),/SESSION_CLOSED/);
    await assert.rejects(h.access.refreshPreflight(),/SESSION_CLOSED/);
    assert.equal(h.events.filter(x=>x==='canary-POST').length,1);assert.equal(h.events.includes('financial-POST'),false);
  });
  await scenario('create and adoption consume their shared choice before the first awaited check',async()=>{
    const h=await harness();let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    h.control.holdBoundary=async()=>{entered();await waiting;};const adopting=h.access.verifyRegisteredCanary();await started;
    await assert.rejects(h.access.createCanary(),/CANARY_CLOSED/);release();
    assert.equal((await adopting).status,'existing-verified');assert.equal(h.events.includes('canary-POST'),false);
    assert.equal(h.canary.calls.length,3);h.access.close();
  });
  await scenario('an in-flight create also excludes adoption before it reaches the existing-object check',async()=>{
    const h=await harness();let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    h.control.holdBoundary=async()=>{entered();await waiting;};const creating=h.access.createCanary();await started;
    await assert.rejects(h.access.verifyRegisteredCanary(),/CANARY_CLOSED/);release();
    assert.equal((await creating).code,'CANARY_EXISTS');assert.equal(h.events.includes('canary-POST'),false);
    assert.deepEqual(h.canary.calls.map(x=>x.method),['HEAD']);
  });
  await scenario('replacement cannot reuse create, canary creation or old observation and consumes a fresh native attestation once',async()=>{
    const h=await harness({replacing:true}),revisionSha256=hash(previewReplacementRegistrationText(h.revision));
    await h.access.verifyRegisteredCanary();await assert.rejects(h.access.createCanary(),/EXISTING_CANARY_ONLY/);
    const proof={target:{...LATEST_TARGET},operation:'replace-accepted-preview',revisionSha256,previousGeneration:'900719925474099312345',
      previousDisplaySha256:h.revision.previousDisplaySha256,candidateSha256:'c'.repeat(64),registrationSha256:hash(acceptedPreviewRegistrationText(h.revision.registration))};
    await assert.rejects(h.access.verifyDestinationAccess(proof),/OBSERVATION_REQUIRED/);assert.throws(()=>post(h.access),/NAMED_WRITE_REQUIRED/);
    const observation=h.access.beginNativeCanaryObservation();assert.equal(observation.oldCanaryPin.candidateSha256,'a'.repeat(64));
    h.access.attestNativeCanaryObservation({nonce:observation.nonce,observedAt:new Date(h.control.now).toISOString(),...fields()});
    await h.access.verifyDestinationAccess(proof);
    const pins={revisionSha256,previousGeneration:proof.previousGeneration,previousDisplaySha256:proof.previousDisplaySha256,previousRegistrationSha256:h.revision.previousRegistrationSha256};
    await h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},pins);assert.equal(h.events.filter(e=>e==='replacement-POST').length,1);
    await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},pins),/ADMISSION_REQUIRED/);
    await assert.rejects(h.access.verifyDestinationAccess(proof),/OBSERVATION_REQUIRED/);h.access.close();
  });
  await scenario('replacement final canary drift clears observation and admission before any POST',async()=>{
    let changed=false;const h=await harness({replacing:true,editHead:r=>{if(changed)r.headers['x-goog-generation']='92';}});
    await h.access.verifyRegisteredCanary();const challenge=h.access.beginNativeCanaryObservation();
    h.access.attestNativeCanaryObservation({nonce:challenge.nonce,observedAt:new Date(h.control.now).toISOString(),...fields()});changed=true;
    await assert.rejects(h.access.verifyDestinationAccess({target:{...LATEST_TARGET},operation:'replace-accepted-preview',revisionSha256:hash(previewReplacementRegistrationText(h.revision)),
      previousGeneration:'900719925474099312345',previousDisplaySha256:h.revision.previousDisplaySha256,candidateSha256:'c'.repeat(64),registrationSha256:hash(acceptedPreviewRegistrationText(h.revision.registration))}),/CANARY_CURRENT/);
    await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},{}),/ADMISSION_REQUIRED/);assert.ok(!h.events.includes('replacement-POST'));h.access.close();
  });
  const storageProof=h=>({target:{...LATEST_TARGET},operation:'replace-accepted-preview',revisionSha256:hash(previewReplacementRegistrationText(h.revision)),
    previousGeneration:'900719925474099312345',previousDisplaySha256:h.revision.previousDisplaySha256,candidateSha256:'c'.repeat(64),registrationSha256:hash(acceptedPreviewRegistrationText(h.revision.registration))});
  const storagePins=h=>({revisionSha256:storageProof(h).revisionSha256,previousGeneration:storageProof(h).previousGeneration,
    previousDisplaySha256:h.revision.previousDisplaySha256,previousRegistrationSha256:h.revision.previousRegistrationSha256});
  await scenario('named storage access rejects every argument before SDK creation and cannot attest UI',async()=>{
    const h=await harness({replacing:true,storage:true}),before=[...h.events];
    for(const value of [undefined,{}, {approved:true}, {storageOnly:false,request:()=>{}}])await assert.rejects(h.storageFactory(value),/STORAGE_ACCESS_ARGUMENTS_FORBIDDEN/);
    assert.deepEqual(h.events,before);assert.throws(()=>h.access.beginNativeCanaryObservation(),/VISUAL_OBSERVATION_NOT_AVAILABLE/);
    assert.throws(()=>h.access.attestNativeCanaryObservation({approved:true}),/VISUAL_OBSERVATION_NOT_AVAILABLE/);h.access.close();
  });
  await scenario('storage admission still requires the fixed SDK-read canary and fresh IAM, then exactly one named write',async()=>{
    const h=await harness({replacing:true,storage:true});await h.access.verifyRegisteredCanary();const before=h.events.length;
    await h.access.verifyDestinationAccess(storageProof(h));assert.deepEqual(h.events.slice(before),['quick-boundary','canary-GET','canary-GET','canary-HEAD']);
    assert.throws(()=>post(h.access),/NAMED_WRITE_REQUIRED/);await h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h));
    await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h)),/ADMISSION_REQUIRED/);
    await h.access.refreshPreflight();await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);
    assert.equal(h.events.filter(e=>e==='replacement-POST').length,1);assert.ok(!h.events.includes('canary-POST'));h.access.close();
  });
  await scenario('a first invalid storage admission permanently consumes the attempt even before canary verification',async()=>{
    for(const invalid of [{approved:true},null,{get target(){throw Error('SYNTHETIC_GETTER_FAILED');}}]){
      const h=await harness({replacing:true,storage:true});await assert.rejects(h.access.verifyDestinationAccess(invalid));
      await h.access.verifyRegisteredCanary();await h.access.refreshPreflight();await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);
      await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h)),/ADMISSION_REQUIRED/);assert.ok(!h.events.includes('replacement-POST'));h.access.close();
    }
  });
  await scenario('failed storage IAM, canary, expiry or abort cannot rearm after refresh',async st=>{
    for(const kind of ['IAM','delete','canary','expiry','abort'])await st.test(kind,async()=>{
      let changed=false;const h=await harness({replacing:true,storage:true,editHead:r=>{if(changed)r.headers['x-goog-generation']='92';}});
      await h.access.verifyRegisteredCanary();const proof=storageProof(h);
      if(kind==='IAM')h.control.boundaryEdit=b=>{b.actorIdentifier='SYNTHETIC_DIFFERENT_OWNER';};
      if(kind==='delete')h.control.boundaryEdit=b=>{b.bucketTestPermissions.permissions=b.bucketTestPermissions.permissions.filter(p=>p!=='storage.objects.delete');};
      if(kind==='canary')changed=true;if(kind==='expiry')h.control.now+=FULL_PREFLIGHT_TTL_MS+1;
      if(kind==='abort'){const abort=new AbortController();abort.abort();proof.signal=abort.signal;}
      await assert.rejects(h.access.verifyDestinationAccess(proof));h.control.boundaryEdit=null;changed=false;
      await h.access.refreshPreflight();await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);
      await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h)),/ADMISSION_REQUIRED/);assert.ok(!h.events.includes('replacement-POST'));h.access.close();
    });
  });
  await scenario('concurrent storage admissions consume the private lock before the first live await',async()=>{
    const h=await harness({replacing:true,storage:true});await h.access.verifyRegisteredCanary();let release,entered;
    const hold=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});h.control.holdBoundary=async()=>{entered();await hold;};
    const first=h.access.verifyDestinationAccess(storageProof(h));await started;await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);
    release();await first;await h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h));assert.equal(h.events.filter(e=>e==='replacement-POST').length,1);h.access.close();
  });
  await scenario('refresh after a minted storage admission invalidates the permit without reopening admission',async()=>{
    const h=await harness({replacing:true,storage:true});await h.access.verifyRegisteredCanary();await h.access.verifyDestinationAccess(storageProof(h));await h.access.refreshPreflight();
    await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h)),/ADMISSION_REQUIRED/);
    await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);assert.ok(!h.events.includes('replacement-POST'));h.access.close();
  });
  await scenario('failed or wrong-pin named storage writes consume the permit and never reopen it',async st=>{
    for(const kind of ['unknown','wrong-pin'])await st.test(kind,async()=>{
      const h=await harness({replacing:true,storage:true});await h.access.verifyRegisteredCanary();await h.access.verifyDestinationAccess(storageProof(h));
      const pins=storagePins(h);if(kind==='unknown')h.control.postError=true;else pins.previousGeneration='999';
      await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},pins));await h.access.refreshPreflight();
      await assert.rejects(h.access.verifyDestinationAccess(storageProof(h)),/ADMISSION_CLOSED/);
      await assert.rejects(h.access.requestPreviewReplacement('SYNTHETIC',{method:'POST'},storagePins(h)),/ADMISSION_REQUIRED/);
      assert.equal(h.events.filter(e=>e==='replacement-POST').length,kind==='unknown'?1:0);h.access.close();
    });
  });
  await scenario('canary failures retain finite primary and independent cleanup without inspecting taint',async st=>{
    const primary={schema:'xuan.owner-sdk.safe-diagnostics.v1',stage:'canary',errorType:'ReadTimeout',errorCode:'ETIMEDOUT',causeCode:'EPIPE',httpStatus:null,
      casHttpAttempts:0,casHttpAcks:0,readbackMetadataAttempts:0,readbackMetadataSuccesses:0,readbackHtmlAttempts:0,readbackHtmlSuccesses:0};
    const cleanup={...primary,stage:'close',errorType:'PermissionError',errorCode:'EACCES',causeCode:null};
    const failure=(extra={})=>{const e=Object.assign(Error('SYNTHETIC_PRIVATE_TOKEN_DO_NOT_EXPORT'),{safeCode:'READ_FAILED'});for(const[k,v]of Object.entries(extra))Object.defineProperty(e,k,{value:v});return e;};
    await st.test('SDK read and close sidecars pass finite decoder, remain nonenumerable, and admission remains closed',async()=>{
      const e=failure({ownerSafeDiagnostics:primary,ownerSafeCleanupDiagnostics:[cleanup],ownerSafeLocalCleanupCodes:['SDK_LOCAL_CLOSE_FAILED']});
      const h=await harness({canaryError:e}),result=await h.access.verifyRegisteredCanary();
      assert.deepEqual({...result},{status:'blocked',code:'REGISTERED_CANARY_READBACK_FAILED',reason:'READ_FAILED'});
      assert.deepEqual(result.ownerSafeDiagnostics,primary);assert.deepEqual(result.ownerSafeCleanupDiagnostics,[cleanup]);assert.deepEqual(result.ownerSafeLocalCleanupCodes,['SDK_LOCAL_CLOSE_FAILED']);
      assert.equal(Object.getOwnPropertyDescriptor(result,'ownerSafeDiagnostics').enumerable,false);assert.ok(Object.isFrozen(result.ownerSafeDiagnostics));
      assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TOKEN'));await assert.rejects(h.access.verifyRegisteredCanary(),/SESSION_CLOSED/);assert.equal(h.events.filter(x=>x==='canary-GET').length,1);
    });
    await st.test('read primary survives a later explicit close failure as secondary',async()=>{
      const close=failure({ownerSafeDiagnostics:cleanup,ownerSafeLocalCleanupCodes:['SDK_LOCAL_CLOSE_FAILED']});
      const h=await harness({canaryError:failure({ownerSafeDiagnostics:primary}),closeError:close});const r=await h.access.verifyRegisteredCanary();
      assert.equal(r.ownerSafeDiagnostics.errorCode,'ETIMEDOUT');assert.deepEqual(r.ownerSafeCleanupDiagnostics,[cleanup]);assert.deepEqual(r.ownerSafeLocalCleanupCodes,['SDK_LOCAL_CLOSE_FAILED']);assert.equal(h.events.filter(x=>x==='close').length,1);
    });
    await st.test('boundary failure preserves exact original error and readonly primary across close failure',async()=>{
      const e=failure({ownerSafeDiagnostics:{...primary,stage:'boundary'},ownerSafeCleanupDiagnostics:[],ownerSafeLocalCleanupCodes:[]});
      const close=Object.assign(Error('SYNTHETIC_CLOSE_PRIVATE'),{safeCode:'SDK_LOCAL_CLOSE_FAILED'}),events=[];
      await assert.rejects(harness({boundaryError:e,closeError:close,events}),error=>error===e);
      assert.equal(e.ownerSafeDiagnostics.stage,'boundary');assert.equal(e.ownerSafeDiagnostics.errorCode,'ETIMEDOUT');assert.deepEqual(e.safeSecondaryCodes,['SDK_LOCAL_CLOSE_FAILED']);assert.equal(events.filter(x=>x==='close').length,1);
    });
    await st.test('getters and proxy traps on failures and sidecars never execute',async()=>{
      let calls=0;const e=Error();for(const key of ['safeCode','ownerSafeDiagnostics','ownerSafeCleanupDiagnostics','ownerSafeLocalCleanupCodes','name','code','cause','message','stack'])Object.defineProperty(e,key,{get(){calls++;throw Error('SYNTHETIC_TAINT');},configurable:true});
      const h=await harness({canaryError:e}),r=await h.access.verifyRegisteredCanary();assert.equal(r.reason,'CANARY_VALIDATION_FAILED');assert.equal(r.ownerSafeDiagnostics,null);assert.equal(calls,0);
      const proxy=new Proxy(Error(),{get(){calls++;throw Error();},getOwnPropertyDescriptor(){calls++;throw Error();},getPrototypeOf(){calls++;throw Error();}});
      const p=await harness({canaryError:proxy}),pr=await p.access.verifyRegisteredCanary();assert.equal(pr.reason,'CANARY_VALIDATION_FAILED');assert.equal(pr.ownerSafeDiagnostics,null);assert.equal(calls,0);
      const side=new Proxy(primary,{get(){calls++;throw Error();},getOwnPropertyDescriptor(){calls++;throw Error();},getPrototypeOf(){calls++;throw Error();}});
      const sh=await harness({canaryError:failure({ownerSafeDiagnostics:side})});assert.equal((await sh.access.verifyRegisteredCanary()).ownerSafeDiagnostics,null);assert.equal(calls,0);
    });
    await st.test('unknown uppercase and malformed fields cannot be emitted as reasons or diagnostics',async()=>{
      const e=Object.assign(Error('SYNTHETIC_PRIVATE'),{safeCode:'TOKEN_SYNTHETIC_PRIVATE'});Object.defineProperty(e,'ownerSafeDiagnostics',{value:{...primary,errorCode:'TOKEN_SYNTHETIC_PRIVATE'}});
      const h=await harness({canaryError:e}),r=await h.access.verifyRegisteredCanary();assert.equal(r.reason,'CANARY_VALIDATION_FAILED');assert.equal(r.ownerSafeDiagnostics,null);assert.ok(!JSON.stringify({...r,diagnostics:r.ownerSafeDiagnostics}).includes('SYNTHETIC_PRIVATE'));
    });
    await st.test('previous finite report origin survives wrapping; invalid or getter origins fail closed',async()=>{
      const origin={type:'TypeError',code:null,causeCode:'ENOTFOUND',httpStatus:null};
      const e=Object.assign(failure({safeOrigin:origin}),{safeCode:'REPORT_SOURCE_NETWORK_FAILED'});
      const h=await harness({canaryError:e}),r=await h.access.verifyRegisteredCanary();assert.deepEqual(r.safeOrigin,origin);assert.equal(r.reason,'REPORT_SOURCE_NETWORK_FAILED');
      const bad=await harness({canaryError:failure({safeOrigin:{...origin,code:'TOKEN_PRIVATE'}})});assert.deepEqual((await bad.access.verifyRegisteredCanary()).safeOrigin,{type:null,code:null,causeCode:null,httpStatus:null});
      let reads=0;const taint=failure();Object.defineProperty(taint,'safeOrigin',{get(){reads++;throw Error();}});const getter=await harness({canaryError:taint});assert.deepEqual((await getter.access.verifyRegisteredCanary()).safeOrigin,{type:null,code:null,causeCode:null,httpStatus:null});assert.equal(reads,0);
    });
    await st.test('nonextensible boundary error remains the primary even when close cannot attach secondary',async()=>{
      const e=Object.freeze(failure()),close=Object.assign(Error(),{safeCode:'SDK_LOCAL_CLOSE_FAILED'});await assert.rejects(harness({boundaryError:e,closeError:close}),error=>error===e);
    });
  });
  assert.equal(completedScenarios,18,'all factory scenarios must execute, including in the child fallback');
  process.stdout.write('SYNTHETIC_FACTORY_SCENARIOS_COMPLETED:'+completedScenarios+'\n');
});
