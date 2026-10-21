import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createOwnerLatestPublisher, planOwnerLatest, OWNER_SCOPE,ACCEPTED_PREVIEW_SCHEMA,
  validateAcceptedPreviewMetadata,previewMetadataSha256,LATEST_HEADERS,ownerJsonMediaHeadersMatch,
} from './owner_latest.mjs';

// Formal regressions from the independent r1 review. All identities, reports,
// receipts, time limits and adapter responses are synthetic, with no real I/O.
const OWNER = 'a'.repeat(64), SOURCE = 'b'.repeat(64), POLICY = 'c'.repeat(64);
const NOW = Date.parse('2026-10-16T12:10:00.000Z');
const encode = text => new TextEncoder().encode(text);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = bytes => new Uint8Array(bytes);
const observedWireHeaders={contentType:'text/html; charset=utf-8',contentDisposition:'attachment',cacheControl:'no-cache, no-store, max-age=0, must-revalidate'};
test('fixed JSON media headers accept exactly two complete profiles without changing stored defaults',()=>{
  assert.equal(ownerJsonMediaHeadersMatch({...LATEST_HEADERS}),true);
  assert.equal(ownerJsonMediaHeadersMatch({...observedWireHeaders}),true);
  assert.deepEqual(LATEST_HEADERS,{contentType:'text/html; charset=utf-8',contentDisposition:'inline',cacheControl:'private, no-store, max-age=0'});
  assert.equal(Object.isFrozen(LATEST_HEADERS),true);
});
test('fixed JSON media header profiles reject mixing, weaker cache controls, unknown values and malformed inputs',()=>{
  for(const value of [
    {...LATEST_HEADERS,contentDisposition:'attachment'},
    {...observedWireHeaders,contentDisposition:'inline'},
    {...observedWireHeaders,cacheControl:'no-cache'},
    {...observedWireHeaders,cacheControl:'no-cache, max-age=0, must-revalidate'},
    {...observedWireHeaders,cacheControl:'no-cache, no-store, must-revalidate'},
    {...LATEST_HEADERS,cacheControl:'public, no-store, max-age=0'},
    {...LATEST_HEADERS,cacheControl:'private, no-store, max-age=600'},
    {...observedWireHeaders,cacheControl:'no-cache, no-store, max-age=0, must-revalidate, immutable'},
    {...observedWireHeaders,contentDisposition:'attachment; filename=unknown.html'},
    {...observedWireHeaders,contentType:'text/html'},
    {...observedWireHeaders,contentEncoding:'identity'},
    {contentType:LATEST_HEADERS.contentType,contentDisposition:'inline'},null,undefined,[],
    Object.assign(Object.create(null),observedWireHeaders),
  ])assert.equal(ownerJsonMediaHeadersMatch(value),false);
  const accessor={...observedWireHeaders};Object.defineProperty(accessor,'contentType',{get(){throw Error('must not invoke accessor');}});
  assert.equal(ownerJsonMediaHeadersMatch(accessor),false);
  const hidden={...observedWireHeaders};Object.defineProperty(hidden,'unknown',{value:true});assert.equal(ownerJsonMediaHeadersMatch(hidden),false);
  assert.equal(ownerJsonMediaHeadersMatch({...observedWireHeaders,[Symbol('unknown')]:true}),false);
});
const receiptText = day => JSON.stringify({ synthetic: true, receiptFor: day });
const proof = ({ metadata: m }) => ({
  scope: m.scope, ownerBinding: m.ownerBinding, artifactSha256: m.artifactSha256,
  receiptSha256: m.receiptSha256, sourceIdentitySha256: m.sourceIdentitySha256,
  policyRevision: POLICY, financialStatus: m.financialStatus,
});
function bundle(day, text, { buffer = false } = {}) {
  const bytes = text => buffer ? Buffer.from(text) : encode(text);
  const html = bytes(text), receipt = bytes(receiptText(day));
  return { html, receipt, metadata: {
    schema: 'xuan.owner-latest.v1', scope: OWNER_SCOPE, ownerBinding: OWNER,
    sourceIdentitySha256: SOURCE, dataDate: day, sourceDate: day,
    captureStartedAt: `${day}T12:00:00.000Z`, captureEndedAt: `${day}T12:01:00.000Z`,
    completedAt: `${day}T12:02:00.000Z`, artifactObject: `delivery/${day}/report.html`,
    artifactGeneration: '31', artifactSha256: hash(html), receiptObject: `delivery/${day}/receipt.json`,
    receiptGeneration: '32', receiptSha256: hash(receipt), financialStatus: 'complete', unknownFields: [],
  } };
}
const previous = options => bundle('2026-10-15', 'synthetic historical report', options);
const candidate = options => bundle('2026-10-16', 'synthetic new private report', options);
const currentOf = (value, { buffer = false } = {}) => ({
  state: 'present', generation: '7', bundle: value,
  displayBytes: buffer ? Buffer.from(value.html) : copy(value.html),
});
const options = (extra = {}) => ({ candidate: candidate(), current: { state: 'absent' },
  ownerBinding: OWNER, now: NOW, verifyProtectedReceipt: proof, prepareDisplay: copy, hash, ...extra });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function pauseFirstProof() {
  const entered = deferred(), release = deferred();
  let first = true;
  return { entered, release, async verify(args) {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return proof(args);
  } };
}

test('standalone planner snapshots current generation before its first asynchronous verification', { timeout: 2000 }, async () => {
  const current = currentOf(previous()), pause = pauseFirstProof();
  const pending = planOwnerLatest(options({ current, verifyProtectedReceipt: pause.verify }));
  await pause.entered.promise;
  current.generation = '99';
  pause.release.resolve();
  const result = await pending;
  assert.equal(result.status, 'ready');
  assert.equal(result.ifGenerationMatch, '7', 'generation must remain bound to the original current bundle');
});

test('planner snapshots candidate and historical Buffer bytes without Buffer.slice aliases', async t => {
  for (const target of ['candidate HTML', 'candidate receipt', 'historical HTML', 'historical receipt', 'historical display']) {
    await t.test(target, { timeout: 2000 }, async () => {
      const next = candidate({ buffer: true }), prior = previous({ buffer: true });
      const current = currentOf(prior, { buffer: true }), pause = pauseFirstProof();
      const originalHtml = copy(next.html), originalReceipt = copy(next.receipt);
      const originals = {
        'candidate HTML': next.html, 'candidate receipt': next.receipt,
        'historical HTML': prior.html, 'historical receipt': prior.receipt,
        'historical display': current.displayBytes,
      };
      assert.ok(Buffer.isBuffer(originals[target]));
      const pending = planOwnerLatest(options({ candidate: next, current, verifyProtectedReceipt: pause.verify }));
      await pause.entered.promise;
      originals[target].fill(88);
      pause.release.resolve();
      const result = await pending;
      assert.equal(result.status, 'ready', `${target} mutation must not change a captured snapshot`);
      assert.equal(result.ifGenerationMatch, '7');
      assert.deepEqual(copy(result.bundle.html), originalHtml);
      assert.deepEqual(copy(result.bundle.receipt), originalReceipt);
      assert.equal(hash(result.bundle.html), result.bundle.metadata.artifactSha256);
      assert.equal(hash(result.bundle.receipt), result.bundle.metadata.receiptSha256);
      assert.equal(hash(result.display), result.displaySha256);
    });
  }
});

test('derived display bytes are detached before asynchronous hashing', async t => {
  for (const buffer of [false, true]) await t.test(buffer ? 'Buffer renderer result' : 'Uint8Array renderer result', { timeout: 2000 }, async () => {
    const rendered = buffer ? Buffer.from('SYNTHETIC-SAFE-DISPLAY') : encode('SYNTHETIC-SAFE-DISPLAY');
    const initial = copy(rendered), initialHash = hash(initial), entered = deferred(), release = deferred();
    const pending = planOwnerLatest(options({ prepareDisplay: () => rendered, async hash(bytes) {
      const digest = hash(bytes);
      // Compare content, not reference identity: a correct implementation passes
      // a detached array into the hash function.
      if (digest === initialHash) { entered.resolve(); await release.promise; }
      return digest;
    } }));
    await entered.promise;
    rendered.fill(88);
    release.resolve();
    const result = await pending;
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.display, initial);
    assert.equal(result.displaySha256, initialHash);
    assert.equal(hash(result.display), result.displaySha256, 'planned bytes must match the planned digest');
  });
});

test('publisher captures Buffer candidate before a delayed latest read', { timeout: 2000 }, async () => {
  const next = candidate({ buffer: true }), initialHtml = copy(next.html), initialReceipt = copy(next.receipt);
  const readStarted = deferred(), finishRead = deferred(), writes = [];
  const instance = createOwnerLatestPublisher({ ownerBinding: OWNER,
    verifyProtectedReceipt: proof, prepareDisplay: copy, hash, now: () => NOW,
    io: {
      async readLatest() { readStarted.resolve(); return finishRead.promise; },
      async replaceLatest(args) { writes.push(args); return { ...args.target, generation: '1', size: args.bytes.length }; },
      async readLatestGeneration() { return new Uint8Array(writes[0].bytes); },
    },
  });
  const pending = instance.publish(next);
  await readStarted.promise;
  next.html.fill(88); next.receipt.fill(88);
  finishRead.resolve({ state: 'absent' });
  assert.equal((await pending).status, 'published-verified');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].bytes, initialHtml);
  assert.equal(writes[0].metadata.artifactSha256, hash(initialHtml));
  assert.equal(writes[0].metadata.receiptSha256, hash(initialReceipt));
});

function strictSyntheticVerifier(seen) {
  return args => {
    const { metadata: m, html, receipt, phase } = args;
    seen.push({ phase, dataDate: m.dataDate });
    assert.ok(['candidate-admission', 'historical-authenticity'].includes(phase), 'a verification phase is mandatory');
    if (m.scope !== OWNER_SCOPE || m.ownerBinding !== OWNER || m.sourceIdentitySha256 !== SOURCE) {
      throw Object.assign(Error('synthetic identity rejected'), { safeCode: 'SYNTHETIC_IDENTITY_REJECTED' });
    }
    if (hash(html) !== m.artifactSha256 || hash(receipt) !== m.receiptSha256
      || hash(receipt) !== hash(encode(receiptText(m.dataDate)))) {
      throw Object.assign(Error('synthetic receipt rejected'), { safeCode: 'SYNTHETIC_RECEIPT_REJECTED' });
    }
    // This arbitrary test-only threshold demonstrates the controller's gate;
    // it does not define or relax any live financial freshness policy.
    if (phase === 'candidate-admission' && args.now - Date.parse(m.captureStartedAt) > 30 * 60 * 1000) {
      throw Object.assign(Error('synthetic candidate stale'), { safeCode: 'SYNTHETIC_SOURCE_STALE' });
    }
    return proof(args);
  };
}

test('fresh candidate and older current use distinct protected verification phases', async () => {
  const seen = [], prior = previous();
  const result = await planOwnerLatest(options({ current: currentOf(prior),
    verifyProtectedReceipt: strictSyntheticVerifier(seen) }));
  assert.equal(result.status, 'ready');
  assert.equal(result.ifGenerationMatch, '7');
  assert.deepEqual(seen, [
    { phase: 'candidate-admission', dataDate: '2026-10-16' },
    { phase: 'historical-authenticity', dataDate: '2026-10-15' },
  ]);
});

test('old candidate cannot downgrade its admission phase or bypass the current freshness callback', async () => {
  const seen = [];
  const result = await planOwnerLatest(options({ candidate: previous(),
    phase: 'historical-authenticity', verifyProtectedReceipt: strictSyntheticVerifier(seen),
    prepareDisplay() { throw Error('a rejected candidate must not reach rendering'); },
  }));
  assert.deepEqual(result, { status: 'blocked', code: 'SYNTHETIC_SOURCE_STALE' });
  assert.deepEqual(seen, [{ phase: 'candidate-admission', dataDate: '2026-10-15' }]);
});

test('historical-authenticity still rejects unauthenticated source and receipt evidence', async t => {
  for (const [name, mutate, expectedCode] of [
    ['different owner binding', prior => { prior.metadata.ownerBinding = 'd'.repeat(64); }, 'SCOPE_MISMATCH'],
    ['untrusted source identity', prior => { prior.metadata.sourceIdentitySha256 = 'd'.repeat(64); }, 'SYNTHETIC_IDENTITY_REJECTED'],
    ['changed historical HTML bytes', prior => { prior.html[0] ^= 1; }, 'HASH_MISMATCH'],
    ['changed historical receipt bytes', prior => { prior.receipt[0] ^= 1; }, 'HASH_MISMATCH'],
    ['self-consistent but untrusted receipt', prior => {
      prior.receipt = encode('{"synthetic":true,"untrustedReceipt":true}');
      prior.metadata.receiptSha256 = hash(prior.receipt);
    }, 'SYNTHETIC_RECEIPT_REJECTED'],
  ]) await t.test(name, async () => {
    const seen = [], prior = previous(); mutate(prior);
    const result = await planOwnerLatest(options({ current: currentOf(prior),
      verifyProtectedReceipt: strictSyntheticVerifier(seen) }));
    assert.deepEqual(result, { status: 'blocked', code: expectedCode });
    assert.equal(seen[0].phase, 'candidate-admission');
  });
});

test('stale candidate rejection permits no replacement in the synthetic publisher', async () => {
  const seen = [], operations = [];
  const instance = createOwnerLatestPublisher({ ownerBinding: OWNER,
    verifyProtectedReceipt: strictSyntheticVerifier(seen), prepareDisplay: copy, hash, now: () => NOW,
    io: {
      async readLatest() { operations.push('read'); return { state: 'absent' }; },
      async replaceLatest() { operations.push('replace'); throw Error('stale candidate must never be written'); },
      async readLatestGeneration() { throw Error('must not readback a rejected write'); },
    },
  });
  assert.deepEqual(await instance.publish(previous()), { status: 'blocked', code: 'SYNTHETIC_SOURCE_STALE' });
  assert.deepEqual(operations, ['read']);
  assert.equal((await instance.publish(candidate())).code, 'ONE_SHOT_CLOSED');
});

test('flags and caller JSON do not supply live capabilities; construction performs no I/O',async()=>{
  let reads=0;
  const instance=createOwnerLatestPublisher({enabled:true,admissionVerified:true,proof:{approved:true},
    io:{readLatest(){reads++;}},ownerBinding:OWNER});
  assert.equal(reads,0);
  assert.deepEqual(await instance.publish(candidate()),{status:'blocked',code:'CONFIG_UNAVAILABLE'});
  assert.equal(reads,0);
});

test('chronology rejects downgrade and same-source conflicting content',async()=>{
  const newer=candidate(),old=previous();
  assert.equal((await planOwnerLatest(options({candidate:old,current:currentOf(newer)}))).code,'STALE_CANDIDATE');
  const changed=structuredClone(newer);changed.html=encode('synthetic conflicting same source');changed.metadata.artifactSha256=hash(changed.html);
  assert.equal((await planOwnerLatest(options({candidate:changed,current:currentOf(newer)}))).code,'SAME_SOURCE_CONFLICT');
  assert.equal((await planOwnerLatest(options({candidate:newer,current:currentOf(newer)}))).status,'no-op');
});

function runningPublisher({writeError,readback,ackEdit=()=>{},readLatest=async()=>({state:'absent'}),timer}={}){
  const calls=[],next=candidate();let saved;
  const instance=createOwnerLatestPublisher({ownerBinding:OWNER,verifyProtectedReceipt:proof,prepareDisplay:copy,hash,now:()=>NOW,
    ...(timer?{setTimer:timer.setTimer,clearTimer:timer.clearTimer}:{}),io:{
      async readLatest(args){calls.push('read');return readLatest(args);},
      async replaceLatest(args){calls.push('write');saved=new Uint8Array(args.bytes);if(writeError)throw writeError;
        const ack={...args.target,generation:'8',size:saved.length};ackEdit(ack);return ack;},
      async readLatestGeneration(args){calls.push('readback');assert.equal(args.generation,'8');assert.equal(args.sha256,hash(saved));return readback?readback(args):copy(saved);},
    }});
  return {instance,calls,next};
}
test('publisher requires independent bytes before verified and closes after success',async()=>{
  const p=runningPublisher();assert.equal((await p.instance.publish(p.next)).status,'published-verified');
  assert.deepEqual(p.calls,['read','write','readback']);assert.equal((await p.instance.publish(p.next)).code,'ONE_SHOT_CLOSED');
});
test('CAS 412 returns conflict once; network failure after write remains unknown',async()=>{
  for(const [error,status] of [[Object.assign(Error('synthetic conflict'),{status:412}),'conflict'],[Error('synthetic disconnect'),'unknown']]){
    const p=runningPublisher({writeError:error});assert.equal((await p.instance.publish(p.next)).status,status);
    assert.deepEqual(p.calls,['read','write']);assert.equal((await p.instance.publish(p.next)).code,'ONE_SHOT_CLOSED');
  }
});
test('invalid ACK or mismatched readback cannot claim verification',async()=>{
  for(const options of [{ackEdit:ack=>{ack.size++;}},{readback:()=>encode('synthetic wrong readback')},{readback:()=>{throw Error('synthetic unavailable');}}]){
    const p=runningPublisher(options);assert.equal((await p.instance.publish(p.next)).status,'unknown');
    assert.equal(p.calls.filter(x=>x==='write').length,1);
  }
});
test('deadline before write closes transaction and prevents delayed continuation from writing',async()=>{
  let fire;const read=deferred(),entered=deferred(),timer={setTimer(fn){fire=fn;return 1;},clearTimer(){}};
  const p=runningPublisher({timer,readLatest:()=>{entered.resolve();return read.promise;}});
  const pending=p.instance.publish(p.next);await entered.promise;fire();
  assert.deepEqual(await pending,{status:'blocked',code:'DEADLINE'});
  read.resolve({state:'absent'});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(p.calls,['read']);
});
test('deadline during write reports uncertain outcome and never retries',async()=>{
  let fire;const write=deferred(),entered=deferred(),calls=[];
  const instance=createOwnerLatestPublisher({ownerBinding:OWNER,verifyProtectedReceipt:proof,prepareDisplay:copy,hash,now:()=>NOW,
    setTimer(fn){fire=fn;return 1;},clearTimer(){},io:{async readLatest(){return {state:'absent'};},
      async replaceLatest(){calls.push('write');entered.resolve();return write.promise;},async readLatestGeneration(){calls.push('readback');}}});
  const pending=instance.publish(candidate());await entered.promise;fire();
  assert.deepEqual(await pending,{status:'unknown',code:'WRITE_OUTCOME_UNKNOWN'});
  write.resolve({bucket:'family-portfolio-gateway-xuan-preopen-private',object:'delivery/owner-latest.html',generation:'1',size:3});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['write']);
  assert.equal((await instance.publish(candidate())).code,'ONE_SHOT_CLOSED');
});

const MONDAY_NOW=Date.parse('2026-10-19T13:00:00.000Z');
function acceptedPreview(){
  return {state:'present',kind:'accepted-preview',generation:'7000000000000000001',
    displayBytes:Buffer.from('SYNTHETIC ACCEPTED SATURDAY STATIC DISPLAY'),preview:{metadata:{
      schema:ACCEPTED_PREVIEW_SCHEMA,scope:OWNER_SCOPE,ownerBinding:OWNER,sourceIdentitySha256:SOURCE,
      registrationId:'saturday-acceptance-20261017',registrationSha256:'d'.repeat(64),registrationPolicyCommit:'e'.repeat(40),
      dataDate:'2026-10-17',sourceDate:'2026-10-16',captureStartedAt:'2026-10-17T06:54:46.000Z',
      captureEndedAt:'2026-10-17T06:56:43.000Z',completedAt:'2026-10-17T07:00:00.000Z',
      financialStatus:'partial',unknownFields:['orders','cash','prices'],
    }}};
}
async function registeredPreviewVerifier(current=acceptedPreview(),seen=[]){
  const metadataDigest=await previewMetadataSha256(current.preview.metadata),displayDigest=hash(current.displayBytes);
  return async({metadata:m,displayBytes,phase})=>{
    seen.push(phase);
    if(phase!=='historical-authenticity'||await previewMetadataSha256(m)!==metadataDigest||hash(displayBytes)!==displayDigest)
      throw Object.assign(Error('synthetic protected registration mismatch'),{safeCode:'SYNTHETIC_PREVIEW_REJECTED'});
    return {schema:'xuan.owner-accepted-preview-proof.v1',scope:m.scope,ownerBinding:m.ownerBinding,
      sourceIdentitySha256:m.sourceIdentitySha256,registrationId:m.registrationId,registrationSha256:m.registrationSha256,
      registrationPolicyCommit:m.registrationPolicyCommit,displaySha256:displayDigest,metadataSha256:metadataDigest};
  };
}
const mondayCandidate=()=>bundle('2026-10-19','SYNTHETIC NEW MONDAY DAILY REPORT');
test('normal weekday admission can replace registered static preview using its actual generation',async()=>{
  const current=acceptedPreview(),seen=[],normal=[],renders=[];
  const result=await planOwnerLatest(options({candidate:mondayCandidate(),current,now:MONDAY_NOW,
    verifyProtectedReceipt:args=>{normal.push(args.phase);return proof(args);},
    verifyProtectedPreview:await registeredPreviewVerifier(current,seen),prepareDisplay:bytes=>{renders.push(copy(bytes));return copy(bytes);}}));
  assert.equal(result.status,'ready');assert.equal(result.ifGenerationMatch,current.generation);
  assert.deepEqual(normal,['candidate-admission']);assert.deepEqual(seen,['historical-authenticity']);
  assert.equal(renders.length,1,'accepted static preview has no daily original to reconstruct');
  assert.equal(current.preview.metadata.dataDate,'2026-10-17');
});
test('accepted preview cannot enter normal candidate admission or supply JSON trust',async()=>{
  const current=acceptedPreview();let normal=0;
  const previewAsBundle={metadata:current.preview.metadata,html:current.displayBytes,receipt:encode('{}')};
  const rejected=await planOwnerLatest(options({candidate:previewAsBundle,current:{state:'absent'},now:MONDAY_NOW,
    verifyProtectedReceipt:()=>{normal++;throw Error('not normal');}}));
  assert.equal(rejected.status,'blocked');assert.equal(normal,0);
  const result=await planOwnerLatest(options({candidate:mondayCandidate(),current,now:MONDAY_NOW,
    verifyProtectedPreview:{approved:true},previewProof:{approved:true}}));
  assert.equal(result.code,'PROTECTED_PREVIEW_GATES_UNAVAILABLE');
});
test('preview schema, registration, times and financial shape remain exact',async t=>{
  for(const [name,edit] of [
    ['daily original field',m=>{m.artifactObject='delivery/2026-10-17/report.html';}],
    ['wrong schema',m=>{m.schema='xuan.owner-latest.v1';}],
    ['bad registration',m=>{m.registrationPolicyCommit='not-a-commit';}],
    ['future completed',m=>{m.completedAt='2026-10-20T00:00:00.000Z';}],
    ['wrong owner',m=>{m.ownerBinding='f'.repeat(64);}],
    ['unbound financial status',m=>{m.financialStatus='complete';m.unknownFields=[];}],
    ['unknown field',m=>{m.unknownFields.push('unregistered');}],
  ])await t.test(name,async()=>{
    const current=acceptedPreview();edit(current.preview.metadata);
    assert.throws(()=>validateAcceptedPreviewMetadata(current.preview.metadata,{now:MONDAY_NOW,ownerBinding:OWNER}));
  });
});
test('historical preview proof binds all registered metadata and actual static bytes',async t=>{
  for(const [name,edit] of [
    ['registered hash',c=>{c.preview.metadata.registrationSha256='f'.repeat(64);}],
    ['registered commit',c=>{c.preview.metadata.registrationPolicyCommit='f'.repeat(40);}],
    ['registered unknowns',c=>{c.preview.metadata.unknownFields.push('allocation');}],
    ['static display',c=>{c.displayBytes[0]^=1;}],
  ])await t.test(name,async()=>{
    const current=acceptedPreview(),verifyProtectedPreview=await registeredPreviewVerifier();edit(current);
    const result=await planOwnerLatest(options({candidate:mondayCandidate(),current,now:MONDAY_NOW,verifyProtectedPreview}));
    assert.equal(result.code,'SYNTHETIC_PREVIEW_REJECTED');
  });
  const verify=await registeredPreviewVerifier();
  const result=await planOwnerLatest(options({candidate:mondayCandidate(),current:acceptedPreview(),now:MONDAY_NOW,
    verifyProtectedPreview:async args=>({...await verify(args),displaySha256:'f'.repeat(64)})}));
  assert.equal(result.code,'PROTECTED_PREVIEW_GATES_REJECTED');
});
test('weekday candidate cannot regress source identity or chronology behind accepted preview',async t=>{
  for(const [name,edit,code] of [
    ['source identity',m=>{m.sourceIdentitySha256='f'.repeat(64);},'SOURCE_IDENTITY_CHANGED'],
    ['report date',m=>{m.dataDate='2026-10-16';m.sourceDate='2026-10-16';m.artifactObject='delivery/2026-10-16/report.html';m.receiptObject='delivery/2026-10-16/receipt.json';},'STALE_CANDIDATE'],
    ['source date',m=>{m.sourceDate='2026-10-15';},'STALE_CANDIDATE'],
    ['capture start',m=>{m.sourceDate='2026-10-16';m.captureStartedAt='2026-10-16T12:00:00.000Z';},'STALE_CANDIDATE'],
    ['new report date alone',m=>{m.sourceDate='2026-10-16';m.captureStartedAt='2026-10-17T06:54:46.000Z';m.captureEndedAt='2026-10-17T06:56:43.000Z';},'SAME_SOURCE_CONFLICT'],
  ])await t.test(name,async()=>{
    const next=mondayCandidate();edit(next.metadata);
    const result=await planOwnerLatest(options({candidate:next,current:acceptedPreview(),now:MONDAY_NOW,
      verifyProtectedPreview:await registeredPreviewVerifier()}));assert.equal(result.code,code);
  });
});
test('planner detaches preview metadata, unknowns and Buffer before first asynchronous admission',async()=>{
  const current=acceptedPreview(),pause=pauseFirstProof(),verifyProtectedPreview=await registeredPreviewVerifier();
  const pending=planOwnerLatest(options({candidate:mondayCandidate(),current,now:MONDAY_NOW,
    verifyProtectedReceipt:pause.verify,verifyProtectedPreview}));await pause.entered.promise;
  current.generation='999';current.preview.metadata.registrationSha256='f'.repeat(64);
  current.preview.metadata.unknownFields.push('allocation');current.displayBytes.fill(88);pause.release.resolve();
  const result=await pending;assert.equal(result.status,'ready');assert.equal(result.ifGenerationMatch,'7000000000000000001');
});
test('preview metadata digest is independent of object key insertion order',async()=>{
  const m=acceptedPreview().preview.metadata,reverse=Object.fromEntries(Object.entries(m).reverse());
  assert.equal(await previewMetadataSha256(m),await previewMetadataSha256(reverse));
});

test('HK report date is independent of UTC day, NY source date and historical preview date',async()=>{
  for(const [reportDate,sourceDate,instant] of [
    ['2026-10-19','2026-10-16','2026-10-18T16:00:00.000Z'], // Monday HK00, Friday NY.
    ['2026-10-21','2026-10-20','2026-10-20T20:00:00.000Z'],
    ['2026-10-21','2026-10-20','2026-10-20T23:59:59.999Z'],
    ['2026-10-21','2026-10-20','2026-10-21T00:00:00.000Z'],
    ['2027-01-01','2026-12-31','2026-12-31T23:00:00.000Z'],
  ]){
    const next=bundle(reportDate,'SYNTHETIC HKT REPORT');Object.assign(next.metadata,{sourceDate,captureStartedAt:instant,captureEndedAt:instant,completedAt:instant});
    const result=await planOwnerLatest(options({candidate:next,now:Date.parse(instant)}));assert.equal(result.status,'ready',instant);
    const m=next.metadata;const preview={schema:ACCEPTED_PREVIEW_SCHEMA,scope:m.scope,ownerBinding:OWNER,sourceIdentitySha256:SOURCE,
      registrationId:'synthetic-hkt-test',registrationSha256:'d'.repeat(64),registrationPolicyCommit:'a'.repeat(40),
      dataDate:reportDate,sourceDate,captureStartedAt:instant,captureEndedAt:instant,completedAt:instant,financialStatus:'partial',unknownFields:['cash']};
    assert.doesNotThrow(()=>validateAcceptedPreviewMetadata(preview,{now:Date.parse(instant),ownerBinding:OWNER}));
    assert.throws(()=>validateAcceptedPreviewMetadata({...preview,completedAt:new Date(Date.parse(instant)+1).toISOString()},{now:Date.parse(instant)}));
  }
});
test('HK date not yet begun and reversed captures remain structural failures',async()=>{
  const next=candidate();Object.assign(next.metadata,{dataDate:'2026-10-17',sourceDate:'2026-10-15',captureStartedAt:'2026-10-16T15:59:59.000Z',captureEndedAt:'2026-10-16T15:59:59.000Z',completedAt:'2026-10-16T15:59:59.000Z'});
  assert.equal((await planOwnerLatest(options({candidate:next,now:Date.parse('2026-10-16T15:59:59.000Z')}))).code,'TIME_ORDER');
  next.metadata.captureEndedAt='2026-10-16T15:59:58.000Z';assert.equal((await planOwnerLatest(options({candidate:next,now:Date.parse('2026-10-16T16:00:00.000Z')}))).code,'TIME_ORDER');
});
test('crossing HK midnight, 30-minute boundary or reversing clock after validation stops before CAS',async()=>{
  for(const mode of ['midnight','expiry','rollback']){
    const instant=mode==='midnight'?'2026-10-16T15:59:59.000Z':'2026-10-16T12:00:00.000Z',next=candidate();
    Object.assign(next.metadata,{captureStartedAt:instant,captureEndedAt:instant,completedAt:instant});
    let time=Date.parse(instant)+(mode==='expiry'?1800000:0),writes=0;
    const publisher=createOwnerLatestPublisher({io:{readLatest:async()=>({state:'absent'}),replaceLatest:async()=>writes++,readLatestGeneration:async()=>assert.fail()},
      ownerBinding:OWNER,now:()=>time,hash,verifyProtectedReceipt:proof,prepareDisplay:bytes=>{time+=mode==='midnight'?1000:mode==='expiry'?1:-1;return copy(bytes);}});
    assert.equal((await publisher.publish(next)).status,'blocked',mode);assert.equal(writes,0);
  }
});


test('realistic 45s read and access preparation leaves the original 10s CAS/readback window',async()=>{
  let time=NOW,saved,prepares=0;const durations=[],calls=[];
  const p=createOwnerLatestPublisher({ownerBinding:OWNER,verifyProtectedReceipt:proof,prepareDisplay:copy,now:()=>time,
    setTimer(fn,ms){durations.push(ms);return setTimeout(fn,ms);},clearTimer:clearTimeout,
    async prepareCommit({signal}){assert.equal(signal.aborted,false);prepares++;time+=30000;},
    io:{async readLatest(){calls.push('read');time+=15000;return {state:'absent'};},
      async replaceLatest(a){calls.push('write');time+=2000;saved=copy(a.bytes);return {...a.target,generation:'1',size:saved.length};},
      async readLatestGeneration(){calls.push('readback');time+=2000;return copy(saved);}}});
  assert.equal((await p.publish(candidate())).status,'published-verified');assert.deepEqual(durations,[60000,10000]);
  assert.deepEqual(calls,['read','write','readback']);assert.equal(prepares,1);assert.equal((await p.publish(candidate())).code,'ONE_SHOT_CLOSED');
});
test('preparation cannot continue past its budget or admit a newly stale, cross-day or rollback candidate',async()=>{
  for(const kind of ['preparation-deadline','stale','cross-day','rollback']){
    let time=kind==='cross-day'?Date.parse('2026-10-16T15:59:59Z'):NOW,writes=0;
    const next=candidate();if(kind==='cross-day'){next.metadata.captureStartedAt='2026-10-16T15:59:00.000Z';next.metadata.captureEndedAt=next.metadata.completedAt='2026-10-16T15:59:01.000Z';}
    if(kind==='stale')time=Date.parse(next.metadata.captureStartedAt)+1799000;
    const p=createOwnerLatestPublisher({ownerBinding:OWNER,verifyProtectedReceipt:proof,prepareDisplay:copy,now:()=>time,
      prepareCommit:async()=>{time+=kind==='preparation-deadline'?60001:kind==='rollback'?-1:2000;},
      io:{readLatest:async()=>({state:'absent'}),replaceLatest:async()=>{writes++;throw Error();},readLatestGeneration:async()=>assert.fail()}});
    const result=await p.publish(next);assert.equal(result.status,'blocked',kind);assert.equal(writes,0,kind);
    assert.equal((await p.publish(next)).code,'ONE_SHOT_CLOSED');
  }
});
test('preparation timeout aborts a delayed access preparation without a late CAS',async()=>{
  let fire,entered,release,writes=0;const start=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const p=createOwnerLatestPublisher({ownerBinding:OWNER,verifyProtectedReceipt:proof,prepareDisplay:copy,now:()=>NOW,
    setTimer(fn){fire=fn;return 1;},clearTimer(){},prepareCommit:async()=>{entered();await hold;},
    io:{readLatest:async()=>({state:'absent'}),replaceLatest:async()=>{writes++;},readLatestGeneration:async()=>assert.fail()}});
  const pending=p.publish(candidate());await start;fire();assert.deepEqual(await pending,{status:'blocked',code:'DEADLINE'});
  release();await new Promise(r=>setImmediate(r));assert.equal(writes,0);
});

test('one registered same-source correction matches the exact consumed predecessor and generation only',async()=>{
  const {registeredOwnerRecovery,registeredReferenceReplacement,registeredReferenceCapture}=await import('./owner_source_recovery.mjs');
  const reg=registeredOwnerRecovery(),s=reg.supersedes;if(!s)return;
  const candidate={dataDate:reg.dataDate,captureStartedAt:reg.referenceCapture.captureStartedAt,captureEndedAt:reg.referenceCapture.captureCompletedAt,completedAt:reg.dataDate+'T12:00:00.000Z',receiptObject:reg.receiptObject};
  const current={artifactSha256:s.artifactSha256,receiptSha256:s.receiptSha256,completedAt:reg.dataDate+'T08:04:40.858Z',receiptObject:`report-check/orders-probe-${s.requestId}/preview-receipt.json`};
  assert.equal(registeredReferenceReplacement(candidate,current,s.latestGeneration),true);
  assert.equal(registeredReferenceReplacement(candidate,current,'999'),false);
  assert.equal(registeredReferenceReplacement(candidate,{...current,artifactSha256:'0'.repeat(64)},s.latestGeneration),false);
  assert.equal(registeredReferenceReplacement({...candidate,receiptObject:current.receiptObject},current,s.latestGeneration),false);
  assert(registeredReferenceCapture(s.requestId,candidate.captureStartedAt,candidate.captureEndedAt));
});
