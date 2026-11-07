import test from 'node:test';
import assert from 'node:assert/strict';
import {SharesightCloudReader} from './fee-cloud-source.mjs';
import {D,B,cloudFixture} from './fee-sync-test-fixtures.mjs';

// Only synthetic transports and in-memory instances. No real source reads.
const binding=(reader,...args)=>SharesightCloudReader.prototype.getPolicyBinding.call(reader,...args);
const rejected=action=>assert.throws(action,/^Error: FEE_CLOUD_CONFIG$/);

test('policy binding is fixed, deeply frozen and available before source acquisition without IO',()=>{
  const f=cloudFixture(),p=binding(f.reader);
  assert.deepEqual(Object.keys(p),['schema','sourceMode','configuration']);
  assert.equal(p.schema,'fee-console.sync-policy-profile.v1');
  assert.equal(p.sourceMode,'sharesight-reference');
  assert.deepEqual(Object.keys(p.configuration),['feeReaderConfigurationSha256']);
  assert.match(p.configuration.feeReaderConfigurationSha256,/^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.configuration));
  assert.throws(()=>{p.sourceMode='legacy-reconstruction';},TypeError);
  assert.throws(()=>{p.configuration.feeReaderConfigurationSha256='f'.repeat(64);},TypeError);
  assert.deepEqual(binding(f.reader),p);assert.equal(f.calls.length,0);
  for(const text of ['synthetic-client','synthetic-secret','incomeDateEvidence','managementExemptionRegistry','Authorization'])assert.equal(JSON.stringify(p).includes(text),false);
});

test('policy binding does not inspect credentials, transport, optional observers or caller-added hashes',()=>{
  const f=cloudFixture(),before=binding(f.reader);let traps=0;
  for(const key of ['clientId','clientSecret','http','configurationSha256','getPolicyBinding'])Object.defineProperty(f.reader,key,{get(){traps++;throw Error('PRIVATE_SENTINEL');}});
  assert.deepEqual(binding(f.reader),before);assert.equal(traps,0);assert.equal(f.calls.length,0);
});

test('same actual business settings canonicalize insertion order and optional null normalization',()=>{
  const a=cloudFixture(),b=cloudFixture();
  a.reader.incomeDateEvidence={webull:{b:2,a:1},schwab:[]};
  b.reader.incomeDateEvidence={schwab:[],webull:{a:1,b:2}};
  b.reader.managementExemptionRegistry=null;
  b.reader.clientId='another-synthetic-client';b.reader.clientSecret='another-synthetic-secret';
  assert.deepEqual(binding(a.reader),binding(b.reader));assert.equal(a.calls.length+b.calls.length,0);
});

for(const [key,value] of [
  ['sourceMode','legacy-reconstruction'],
  ['incomeDateEvidence',{webull:{audit:'synthetic-only'}}],
  ['reconcileInKind',true],
  ['managedTransferIdentities',{syntheticPolicy:'transfer-scope'}],
  ['managementExemptionRegistry',{syntheticPolicy:'management-scope'}],
])test(`policy digest and capture comparison bind the actual ${key}`,async()=>{
  const f=cloudFixture(),p=binding(f.reader),cap=await f.reader.readStableWithEvidence(D,B),calls=f.calls.length;
  assert.deepEqual(binding(f.reader,cap),p);
  f.reader[key]=value;
  assert.notEqual(binding(f.reader).configuration.feeReaderConfigurationSha256,p.configuration.feeReaderConfigurationSha256);
  rejected(()=>binding(f.reader,cap));assert.equal(f.calls.length,calls);
});

test('policy capability accepts only this reader original capture, including after one-shot consumption',async()=>{
  const f=cloudFixture(),other=cloudFixture(),p=binding(f.reader),cap=await f.reader.readStableWithEvidence(D,B),before=f.calls.length;
  let traps=0;const accessor={};Object.defineProperty(accessor,'evidence',{get(){traps++;throw Error('PRIVATE_SENTINEL');}});
  for(const forged of [null,{},p,accessor,structuredClone(cap),new Proxy(cap,{get(){traps++;throw Error('PRIVATE_SENTINEL');}})])rejected(()=>binding(f.reader,forged));
  rejected(()=>binding(other.reader,cap));rejected(()=>binding(f.reader,cap,p));
  assert.deepEqual(binding(f.reader,cap),p);assert.equal(f.reader.consumeCapturedRead(cap,D,B),cap.input);
  assert.deepEqual(binding(f.reader,cap),p);rejected(()=>f.reader.consumeCapturedRead(cap,D,B));
  assert.equal(f.calls.length,before);assert.equal(other.calls.length,0);assert.equal(traps,0);
});

test('revoked captures cannot obtain policy binding even when original settings are restored',async()=>{
  const f=cloudFixture(),cap=await f.reader.readStableWithEvidence(D,B),before=f.calls.length;
  f.reader.reconcileInKind=true;
  await assert.rejects(f.reader.checkCapturedReadCurrent(cap),/^Error: FEE_CLOUD_SOURCE_UNSTABLE$/);
  f.reader.reconcileInKind=false;
  assert.equal(f.reader.verifyCapturedRead(cap),false);rejected(()=>binding(f.reader,cap));
  assert.equal(f.calls.length,before);assert.equal(binding(f.reader).sourceMode,'sharesight-reference');
});

test('nested policy mutation after capture is detected without disclosing policy content',async()=>{
  const f=cloudFixture();f.reader.incomeDateEvidence={webull:{}};
  const p=binding(f.reader),cap=await f.reader.readStableWithEvidence(D,B),count=f.calls.length;
  f.reader.incomeDateEvidence.webull.privateMarker='synthetic-private-policy-marker';
  rejected(()=>binding(f.reader,cap));
  const fresh=binding(f.reader);assert.notDeepEqual(fresh,p);
  assert.equal(JSON.stringify(fresh).includes('synthetic-private-policy-marker'),false);assert.equal(f.calls.length,count);
});

test('forged or proxied reader receivers are rejected without executing their traps',()=>{
  const real=cloudFixture();let traps=0;
  for(const receiver of [null,undefined,0,'reader',{},Object.create(SharesightCloudReader.prototype),new Proxy(real.reader,{get(){traps++;throw Error('PRIVATE_SENTINEL');},getOwnPropertyDescriptor(){traps++;throw Error('PRIVATE_SENTINEL');}})])rejected(()=>binding(receiver));
  assert.equal(traps,0);assert.equal(real.calls.length,0);
});

test('actual policy getters, inherited fields and proxies fail closed without executing accessors',()=>{
  for(const kind of ['own-getter','nested-getter','proxy','missing-field']){
    const f=cloudFixture();let traps=0;
    if(kind==='own-getter')Object.defineProperty(f.reader,'incomeDateEvidence',{get(){traps++;throw Error('PRIVATE_SENTINEL');}});
    if(kind==='nested-getter'){const v={};Object.defineProperty(v,'private',{enumerable:true,get(){traps++;throw Error('PRIVATE_SENTINEL');}});f.reader.incomeDateEvidence=v;}
    if(kind==='proxy')f.reader.incomeDateEvidence=new Proxy({},{ownKeys(){traps++;throw Error('PRIVATE_SENTINEL');}});
    if(kind==='missing-field')delete f.reader.sourceMode;
    rejected(()=>binding(f.reader));assert.equal(traps,0);assert.equal(f.calls.length,0);
  }
});

test('unsupported, nonfinite or cyclic policy values cannot produce a binding',()=>{
  const cycle={};cycle.self=cycle;
  for(const value of [cycle,{n:NaN},{n:Infinity},{n:-0},{n:1n},{n:undefined},Buffer.from('synthetic'),new Date('2026-01-01'),Array(1)]){
    const f=cloudFixture();f.reader.incomeDateEvidence=value;rejected(()=>binding(f.reader));assert.equal(f.calls.length,0);
  }
  for(const [key,value]of [['sourceMode','caller-authored'],['reconcileInKind',1]]){
    const f=cloudFixture();f.reader[key]=value;rejected(()=>binding(f.reader));assert.equal(f.calls.length,0);
  }
});

for(const operation of ['readStable','readStableWithEvidence'])test(`policy reads refuse an in-flight ${operation} without an extra request`,async()=>{
  const f=cloudFixture(),fetch=f.reader.http.fetchImpl;let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),paused=new Promise(resolve=>{release=resolve;});
  let waiting=true;f.reader.http.fetchImpl=async(url,init)=>{
    if(waiting&&new URL(url).pathname==='/api/v2/portfolios.json'){waiting=false;enter();await paused;}
    return fetch(url,init);
  };
  const work=f.reader[operation](D,B);await entered;const calls=f.calls.length;
  rejected(()=>binding(f.reader));assert.equal(f.calls.length,calls);
  release();await work;assert.equal(binding(f.reader).sourceMode,'sharesight-reference');
});
