import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaily} from './daily.mjs';
test('joint holiday never loads credentials or reads financial sources', async () => {
  const saved = []; let generated = false;
  const result = await runDaily({now: () => Date.parse('2026-12-25T06:00:00Z'), io: {savePrivate: async (name,value) => saved.push({name,value})},
    generate: async () => {generated = true;}});
  assert.equal(generated, false); assert.equal(result.status, 'no-action'); assert.equal(saved.length, 1);
});
test('delivery exposes only HTML and completion receipt, written in that order', async () => {
  const saved = [], io = {savePrivate: async (name,value) => {saved.push({name,value}); return {sha256: 'a'.repeat(64), generation: '1'};}};
  await runDaily({now: () => Date.parse('2026-10-01T06:00:00Z'), execution: 'xuan-preopen-report-test', io, generate: async ({sourceDate,io: wrapped}) => {
    assert.equal(sourceDate,'2026-09-30'); await wrapped.savePrivate('report-check/id/report.html','private html');
    return {status: 'ready', artifact: {}, dataDate: '2026-10-01', sourceDate};
  }});
  assert.deepEqual(saved.map(x => x.name), ['delivery/2026-10-01/europe-regular-v1-2026-10-01-1790834400/start.json','report-check/id/report.html','delivery/2026-10-01/europe-regular-v1-2026-10-01-1790834400/report.html','delivery/2026-10-01/europe-regular-v1-2026-10-01-1790834400/receipt.json']);
});
test('partial generation does not create a delivery completion marker', async () => {
  const saved = [];
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T06:00:00Z'), execution: 'xuan-preopen-report-test', io: {savePrivate: async name => saved.push(name)},
    generate: async () => ({status: 'partial'})}), /INCOMPLETE/);
  assert.deepEqual(saved,['delivery/2026-10-01/europe-regular-v1-2026-10-01-1790834400/start.json']);
});
test('an existing daily start marker blocks duplicate financial generation', async () => {
  let generated = false;
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T06:00:00Z'), execution: 'xuan-preopen-report-test',
    io: {savePrivate: async () => {throw new Error('CLOUD_HTTP_412');}}, generate: async () => {generated = true;}}), /412/);
  assert.equal(generated,false);
});
test('early acceptance and wrong-season runs cannot occupy the formal slot', async () => {
  for (const instant of ['2026-10-05T05:59:59Z','2026-10-26T06:10:00Z','2026-10-05T07:00:00Z']) {
    let called=false;
    const result=await runDaily({now:()=>Date.parse(instant),io:{savePrivate:async()=>{called=true;}},generate:async()=>{called=true;}});
    assert.equal(result.status,'outside-window'); assert.equal(called,false);
  }
});
test('missing upstream coverage produces status receipt and no action HTML', async () => {
  const saved=[];
  const result=await runDaily({now:()=>Date.parse('2026-10-05T06:00:00Z'),execution:'xuan-preopen-report-test',
    io:{savePrivate:async (name,value)=>{saved.push({name,value});}},
    generate:async()=>({status:'data-not-ready',dataDate:'2026-10-05',sourceDate:'2026-10-02'})});
  assert.equal(result.status,'data-not-ready'); assert.equal(saved.length,2);
  assert.ok(saved.every(s=>!s.name.endsWith('report.html')));
});
