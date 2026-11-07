import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SharesightCloudReader,CLOUD_ACCOUNTS} from './fee-cloud-source.mjs';
import {projectCapturedSharesightAccount,capturedInputFailureCode} from './fee-sync-captured-inputs.mjs';

import {D,B,cloudFixture,ibFixture} from './fee-sync-test-fixtures.mjs';

function refused(args,code){assert.throws(()=>projectCapturedSharesightAccount(args),e=>{assert.equal(capturedInputFailureCode(e),'FEE_SYNC_CAPTURE_'+code);return true;});}

test('two-account real validated capture maps exact source bytes without additional IO or consuming the capture',async()=>{
  const f=cloudFixture(),captured=await f.reader.readStableWithEvidence(D,B),calls=f.calls.length;
  for(const role of ['schwab','webull']){
    const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope(role)});
    assert.equal(out.projection.identity.role,role);assert.equal(out.projection.holdings[0].quantity,'10000000000000001e-16');
    assert.equal(out.captureSourceSha256,captured.evidence.sourceSha256);assert.equal(Object.isFrozen(out.raw.cashTransactions),true);
    const performance=captured.evidence.captures[0].records.find(r=>r.path==='/api/v3/portfolios/'+out.scope.portfolioId+'/performance');
    assert.equal(out.raw.performance,performance.body);assert.equal(createHash('sha256').update(out.raw.performance).digest('hex'),performance.sha256);
  }
  assert.equal(f.calls.length,calls);assert.equal(f.reader.consumeCapturedRead(captured,D,B),captured.input);
});
test('IB capture retains the genuine read window and excludes earlier daily anchor reports from target projection',async()=>{
  const f=ibFixture(),captured=await f.reader.readStableWithEvidence(f.args),calls=f.calls.length;
  const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope});
  assert.equal(out.projection.identity.portfolioId,1);assert.equal(out.projection.identity.fromDate,'2026-09-01');
  assert.equal(JSON.parse(out.raw.performance).report.end_date,D);
  assert.ok(captured.evidence.captures[0].records.some(r=>r.query.end_date==='2026-08-31'));
  assert.equal(f.calls.length,calls);assert.equal(f.reader.consumeCapturedRead(captured,f.args),captured.input);
});
test('native linked payout keeps its original body and distinct official paid date',async()=>{
  const f=ibFixture({nativePayout:true}),captured=await f.reader.readStableWithEvidence(f.args),calls=f.calls.length;
  const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope});
  const original=captured.evidence.captures[0].records.find(r=>r.path==='/api/v2/payouts/13.json');
  assert.equal(out.raw.payouts[13],original.body);assert.equal(out.projection.payouts[0].paidOn,D);
  assert.equal(out.projection.cashEvents[0].payoutId,13);assert.equal(out.projection.cashEvents[0].dateTime,D+'T00:00:00.000Z');
  assert.equal(f.calls.length,calls);
});
test('full capture hash binds extra catalog evidence even when selected daily projection is identical',async()=>{
  const a=cloudFixture({catalogNote:'synthetic catalog A'}),b=cloudFixture({catalogNote:'synthetic catalog B'});
  const ca=await a.reader.readStableWithEvidence(D,B),cb=await b.reader.readStableWithEvidence(D,B);
  const pa=projectCapturedSharesightAccount({reader:a.reader,captured:ca,scope:a.scope('schwab')});
  const pb=projectCapturedSharesightAccount({reader:b.reader,captured:cb,scope:b.scope('schwab')});
  assert.equal(pa.projection.sourceSha256,pb.projection.sourceSha256);
  assert.notEqual(pa.captureSourceSha256,pb.captureSourceSha256);
});
test('serialized, cloned, mixed-batch, wrong-instance and unbranded results cannot masquerade as captured evidence',async()=>{
  const f=cloudFixture(),other=cloudFixture(),captured=await f.reader.readStableWithEvidence(D,B),c2=await other.reader.readStableWithEvidence(D,B),scope=f.scope('schwab');
  for(const value of [JSON.parse(JSON.stringify(captured)),structuredClone(captured),{...captured,evidence:{...captured.evidence,captures:[captured.evidence.captures[0],c2.evidence.captures[1]]}},null])refused({reader:f.reader,captured:value,scope},'ORIGIN');
  refused({reader:other.reader,captured,scope},'ORIGIN');
  refused({reader:{verifyCapturedRead:()=>true},captured,scope},'ORIGIN');
  const forged=Object.create(SharesightCloudReader.prototype);forged.verifyCapturedRead=()=>true;refused({reader:forged,captured,scope},'ORIGIN');
});
test('instance method override cannot replace the real private capture registry',async()=>{
  const f=cloudFixture(),captured=await f.reader.readStableWithEvidence(D,B);f.reader.verifyCapturedRead=()=>true;
  refused({reader:f.reader,captured:JSON.parse(JSON.stringify(captured)),scope:f.scope('schwab')},'ORIGIN');
  assert.equal(projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope('schwab')}).projection.identity.role,'schwab');
});
test('scope identity, role, target date and actual query window stay bound',async t=>{
  const f=cloudFixture(),captured=await f.reader.readStableWithEvidence(D,B),scope=f.scope('schwab');
  for(const [name,change,code]of [
    ['different portfolio',s=>s.portfolioId++, 'SCOPE'],['different name',s=>s.name='Other','SCOPE'],
    ['different target',s=>{s.targetDate='2026-09-03';s.fromDate=s.targetDate;},'BATCH'],
    ['two-account widened window',s=>s.fromDate='2026-09-01','DATE'],['invalid role',s=>s.role='other','SCOPE'],
    ['cloud peer is not an IB source capture',s=>Object.assign(s,{role:'ib-manager',name:'IB-HK',portfolioId:1}),'ORIGIN']
  ])await t.test(name,()=>{const s={...scope};change(s);refused({reader:f.reader,captured,scope:s},code);});
  const ib=ibFixture(),ic=await ib.reader.readStableWithEvidence(ib.args);
  refused({reader:ib.reader,captured:ic,scope:{...ib.scope,fromDate:D}},'MISSING');
  refused({reader:ib.reader,captured:ic,scope:{...ib.scope,portfolioId:2}},'IDENTITY');
});
test('duplicate original GET records are rejected even when original reader registered the result',async()=>{
  const f=cloudFixture({extraListing:true}),captured=await f.reader.readStableWithEvidence(D,B);
  assert.equal(f.reader.verifyCapturedRead(captured),true);
  assert.equal(captured.evidence.captures[0].records.filter(r=>r.path==='/api/v2/portfolios.json').length,2);
  refused({reader:f.reader,captured,scope:f.scope('schwab')},'DUPLICATE');
});
test('hostile options, scope, readers and capture proxies are rejected without executing traps',()=>{
  let calls=0;const trap={get(){calls++;throw Error('private-canary');},getPrototypeOf(){calls++;throw Error('private-canary');},ownKeys(){calls++;throw Error('private-canary');}};
  for(const request of [null,new Proxy({},trap),{get reader(){calls++;throw Error('private-canary');},captured:{},scope:{}},
    {reader:{},captured:{},scope:new Proxy({},trap)},{reader:new Proxy({},trap),captured:{},scope:{role:'schwab',...CLOUD_ACCOUNTS.schwab,targetDate:D,fromDate:D}}])
    assert.throws(()=>projectCapturedSharesightAccount(request),e=>{assert.match(capturedInputFailureCode(e),/^FEE_SYNC_CAPTURE_/);assert.doesNotMatch(e.message,/private-canary/);return true;});
  assert.equal(calls,0);
});
