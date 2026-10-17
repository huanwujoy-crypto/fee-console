import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {describeOwnerBoundary,evaluateOwnerBoundary,renderOwnerPhoneCanary,validateOwnerPhoneCanary,
  validateOwnerCanaryMetadata,validateOwnerBoundaryWindow,validateOwnerPreflightAge,FULL_PREFLIGHT_TTL_MS,
  MAX_CANARY_BYTES,CANARY_TARGET,createOwnerPreflightLease} from './owner_preview_access.mjs';
import {LATEST_TARGET,LATEST_HEADERS} from './owner_latest.mjs';
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
