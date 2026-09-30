import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaily} from './daily.mjs';
test('joint holiday never loads credentials or reads financial sources', async () => {
  const saved = []; let generated = false;
  const result = await runDaily({now: () => Date.parse('2026-12-25T05:00:00Z'), io: {savePrivate: async (name,value) => saved.push({name,value})},
    generate: async () => {generated = true;}});
  assert.equal(generated, false); assert.equal(result.status, 'no-action'); assert.equal(saved.length, 1);
});
test('delivery exposes only HTML and completion receipt, written in that order', async () => {
  const saved = [], io = {savePrivate: async (name,value) => {saved.push({name,value}); return {sha256: 'a'.repeat(64), generation: '1'};}};
  await runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), io, generate: async ({sourceDate,io: wrapped}) => {
    assert.equal(sourceDate,'2026-09-30'); await wrapped.savePrivate('report-check/id/report.html','private html');
    return {status: 'ready', artifact: {}, dataDate: '2026-10-01', sourceDate};
  }});
  assert.deepEqual(saved.map(x => x.name), ['report-check/id/report.html','delivery/2026-10-01/report.html','delivery/2026-10-01/receipt.json']);
});
test('partial generation does not create a delivery completion marker', async () => {
  const saved = [];
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), io: {savePrivate: async name => saved.push(name)},
    generate: async () => ({status: 'partial'})}), /INCOMPLETE/);
  assert.equal(saved.length,0);
});
