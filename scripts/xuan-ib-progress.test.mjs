import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProgressJson, validateProgress, checkProgress } from './xuan-ib-progress.mjs';

const ledger = JSON.parse(fs.readFileSync(new URL('../xuan-ib/implementation-progress.json', import.meta.url),'utf8'));
const html = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url),'utf8');
const state = JSON.parse(html.match(/<template id="xuan-ib-decision-state-v1"[^>]*>([\s\S]*?)<\/template>/)[1]);
const now = Date.parse(ledger.events.at(-1).recordedAtHkt)+120000;
const followup = new Date(now-60000+28800000).toISOString().slice(0,19)+'+08:00';
const copy = v => JSON.parse(JSON.stringify(v));
test('published progress matches original receipts and shared validator', () => { checkProgress(); });
test('strict JSON rejects duplicate keys, trailing content and nesting overflow', () => {
  for (const s of ['{"a":1,"a":2}','{}x','['.repeat(30)+']'.repeat(30),'{"a":}'])
    assert.throws(() => parseProgressJson(s));
  assert.equal(parseProgressJson('{"a":[1,true,null,"text"]}').a[3], 'text');
});
test('all three original decisions stay accepted; progress is separate', () => {
  assert.equal(state.decisions.filter(d=>d.status==='accepted').length,3);
  assert.equal(new Set(validateProgress(copy(ledger),state,null,now).events.map(e=>e.decisionId)).size,3);
});
test('GOOG scope confirmation is a new event, not a rewritten opinion or a completed financial report', () => {
  const prior=ledger.events.find(e=>e.eventId==='P-20260831-2');
  const confirmation=ledger.events.find(e=>e.eventId==='P-20260831-5');
  assert.equal(prior.status,'awaiting_approval');
  assert.equal(confirmation.status,'in_progress');
  for (const field of ['decisionId','receiptId','responseToSourceSha','responseToHtmlBlob'])
    assert.equal(confirmation[field],prior[field]);
  assert.ok(Date.parse(confirmation.recordedAtHkt)>Date.parse(prior.recordedAtHkt));
  assert.match(confirmation.summary,/IB、Schwab、Webull 三账户合并观察/);
  assert.match(confirmation.summary,/现有阈值不变/);
  assert.match(confirmation.nextAction,/未重新取数或生成新报告/);
  const spec=fs.readFileSync(new URL('../claude/xuan-ib-implementation-progress-v1.md',import.meta.url),'utf8');
  assert.match(spec,/IB NAV＋NOAH-HK 现金/);
  assert.match(spec,/不做等美元阈值换算/);
});
for (const [name, mutate] of [
  ['unknown fields', d=>d.extra=true],
  ['duplicate events', d=>d.events.push(copy(d.events[0]))],
  ['wrong receipt', d=>d.events[0].receiptId='R-20260831-000000-XXXXXXXX'],
  ['wrong decision', d=>d.events[0].decisionId='D-20260830-UNKNOWN'],
  ['wrong source receipt pair', d=>d.events[0].responseToSourceSha='0'.repeat(40)],
  ['wrong receipt blob', d=>d.events[0].responseToHtmlBlob='0'.repeat(40)],
  ['invalid evidence pair', d=>d.events[0].observedPair.htmlBlob='not-a-hash'],
  ['future timestamp', d=>d.events[0].recordedAtHkt='2099-01-01T00:00:00+08:00'],
  ['invalid calendar', d=>d.events[0].recordedAtHkt='2026-02-30T00:00:00+08:00'],
  ['review before event', d=>d.events[0].reviewAfterHkt='2026-08-30T00:00:00+08:00'],
  ['missing blocker', d=>d.events[0].blocker=''],
  ['empty evidence for applied state', d=>{d.events[0].status='evidence_recorded';d.events[0].evidence=[];}],
  ['cannot claim entire task completed', d=>d.events[0].status='completed'],
  ['unsafe html', d=>d.events[0].summary='<script>alert(1)</script>'],
  ['unsafe URL', d=>d.events[0].nextAction='https://example.test'],
  ['private token', d=>d.events[0].summary='token: example'],
  ['private contact', d=>d.events[0].summary='person@example.test'],
  ['overlong text', d=>d.events[0].summary='字'.repeat(181)]
]) test(name, () => {
  const d=copy(ledger); mutate(d);
  assert.throws(()=>validateProgress(d,state,null,now));
});
test('deferred receipt cannot justify an implementation event',()=>{
  const s=copy(state);s.receipts[0].action='deferred';
  assert.throws(()=>validateProgress(copy(ledger),s,null,now));
});
test('existing valid millisecond-precision receipts also accept independent progress',()=>{
  const s=copy(state);s.receipts[0].recordedAtHkt='2026-08-31T06:49:06.123+08:00';
  validateProgress(copy(ledger),s,null,now);
});
test('append-only accepts appended progress but never edits existing events',()=>{
  const d=copy(ledger);d.revision++;
  d.events.push({...copy(d.events[2]),eventId:'P-NEXT',recordedAtHkt:followup});
  validateProgress(d,state,ledger,now);
  const bad=copy(d);bad.events[0].summary='修改历史';
  assert.throws(()=>validateProgress(bad,state,ledger,now));
  const removed=copy(d);removed.events.shift();
  assert.throws(()=>validateProgress(removed,state,ledger,now));
  assert.throws(()=>validateProgress(ledger,state,d,now));
});
test('same revision cannot mutate payload and higher revision needs a new event',()=>{
  const d=copy(ledger);d.events.push({...copy(d.events[2]),eventId:'P-NEXT'});
  assert.throws(()=>validateProgress(d,state,ledger,now));
  const other=copy(ledger);other.revision++;
  assert.throws(()=>validateProgress(other,state,ledger,now));
});
test('historical accepted receipts remain valid when original decision is superseded',()=>{
  const s=copy(state);s.decisions[0].status='superseded';
  validateProgress(copy(ledger),s,null,now); // presentation filters this out
});
test('promotion does not acquire a progress-ledger write path',()=>{
  const promotion=fs.readFileSync(new URL('../.github/workflows/promote-xuan-ib-handover.yml', import.meta.url),'utf8');
  assert.doesNotMatch(promotion,/implementation-progress/);
  const policy=fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url),'utf8');
  assert.match(policy,/xuan-ib-progress/);
  assert.match(policy,/xuan-ib-classification-audit/);
});
