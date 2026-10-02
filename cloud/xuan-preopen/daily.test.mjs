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
test('formal unconfigured source coverage creates only protected non-action status',async()=>{
 const {statusFixture}=await import('./test_fixtures.mjs');const f=statusFixture();const saved=[];
 const result=await runDaily({now:f.now,execution:'xuan-preopen-report-test',io:{savePrivate:async(name,value)=>{saved.push({name,value});return{sha256:'a'.repeat(64),generation:'1'};}},generate:async options=>{assert.equal(options.requireActionEvidence,true);return{...f.receipt,expiresAt:f.model.expiresAt,previousDataDate:f.model.previousDataDate,previousReportSha:f.model.previousReportSha,previousSourceSha:f.model.previousSourceSha};}});
 assert.equal(result.status,'data-not-ready');assert.equal(saved.length,3);assert.ok(saved[1].value.includes('暂无行动建议'));assert.ok(saved[1].value.includes('上一份报告原日期：2026-10-01'));assert.equal(saved[2].value.artifact.privateObject,saved[1].name);
});
test('each later immutable attempt has a finite private path; a same-bucket CAS loser does no source work',async()=>{
 const {statusFixture}=await import('./test_fixtures.mjs');
 for(const instant of ['2026-10-05T06:11:00Z','2026-10-05T06:21:00Z']){const f=statusFixture(Date.parse(instant)),saved=[];await runDaily({now:f.now,execution:'xuan-preopen-report-test',io:{savePrivate:async(name,value)=>{saved.push(name);return{sha256:'a'.repeat(64),generation:'1'};}},generate:async()=>({...f.receipt,expiresAt:f.model.expiresAt,previousDataDate:f.model.previousDataDate,previousReportSha:f.model.previousReportSha,previousSourceSha:f.model.previousSourceSha})});assert.ok(saved.every(name=>name.includes(`/retry-${f.attempt}/`)));}
 let generated=0;await assert.rejects(runDaily({now:()=>Date.parse('2026-10-05T06:21:00Z'),execution:'xuan-preopen-report-test',io:{savePrivate:async()=>{throw Error('CLOUD_HTTP_412');}},generate:async()=>{generated++;}}),/412/);assert.equal(generated,0);
});
