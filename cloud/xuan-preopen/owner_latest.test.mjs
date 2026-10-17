import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createOwnerLatestPublisher, planOwnerLatest, OWNER_SCOPE,
} from './owner_latest.mjs';

// Formal regressions from the independent r1 review. All identities, reports,
// receipts, time limits and adapter responses are synthetic, with no real I/O.
const OWNER = 'a'.repeat(64), SOURCE = 'b'.repeat(64), POLICY = 'c'.repeat(64);
const NOW = Date.parse('2026-10-16T12:10:00.000Z');
const encode = text => new TextEncoder().encode(text);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = bytes => new Uint8Array(bytes);
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
