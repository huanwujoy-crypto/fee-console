import {IB_READINESS_KEYS} from './source_readiness.mjs';
import {renderNightActionReport,extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {collectDelivery, deliveryTransport} from './delivery.mjs';
const html = renderNightActionReport({schemaVersion: 5, dataDate: '2026-10-01', status: 'ready', asOfHkt: '2026-10-01 14:00 HKT · 数据至 2026-09-30', replenishment: {status:'ready',total:0,budget:0,retained:0,items:[{symbol:'EXUS',amount:0}]}, orders:{status:'ready',asOfHkt:'14:00',buys:[],sells:[]},cash:{status:'ready',ib:0,noah:0,pool:0,reserve:0,callApplied:0,planning:0,orderReserve:0,totalCapacity:0,cashLike:{total:0,items:[]}},allocation:{status:'unavailable',categories:[]},notes:[]});
const now = () => Date.parse('2026-10-01T06:00:00Z');
const JOB = 'projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report';
const receipt = JSON.stringify({status: 'ready', readiness: {status:'ready',targetTradeDate:'2026-09-30',issues:[],evidence:IB_READINESS_KEYS.map(sourceKey=>({sourceKey,targetTradeDate:'2026-09-30',coveredThroughDate:'2026-09-30',asOf:new Date(now()).toISOString(),snapshotId:'synthetic'}))}, sources:IB_READINESS_KEYS.map(sourceKey=>({sourceKey,sha256:'f'.repeat(64)})),startedAt:new Date(now()).toISOString(),completedAt:new Date(now()).toISOString(), slotId:'europe-regular-v1-2026-10-01-1790834400', dataDate: '2026-10-01', sourceDate: '2026-09-30', artifact: {privateObject: 'delivery/2026-10-01/europe-regular-v1-2026-10-01-1790834400/report.html',
  sha256: crypto.createHash('sha256').update(html).digest('hex')}});
test('one run request is followed by exact execution status and completed private files', async () => {
  const calls = []; let reads = 0;
  const result = await collectDelivery({now, request: async (url,options = {}) => {
    calls.push({url,options});
    if (url.endsWith(':run')) return JSON.stringify({metadata: {name: JOB+'/executions/test-run'}});
    if (url.includes('/executions/')) return JSON.stringify({completionTime: 'time', succeededCount: 1, taskCount: 1});
    if (url.includes('receipt.json')) return ++reads === 1 ? null : receipt;
    if (url.includes('start.json')) return null;
    return html;
  }, loadContext: async () => ({previousHtml: 'old html'})});
  assert.equal(result.outcome,'generated'); assert.equal(calls.filter(x => x.options.method === 'POST').length,1);
  assert.ok(calls.filter(x => x.url.includes('storage.googleapis')).every(x => x.url.includes('delivery%2F2026-10-01%2Feurope-regular-v1-2026-10-01-1790834400%2F')));
});
test('an incomplete earlier run is followed instead of starting a second job', async () => {
  let reads = 0;
  const result = await collectDelivery({now, request: async (url,options = {}) => {
    assert.notEqual(options.method,'POST');
    if (url.includes('receipt.json')) return ++reads === 1 ? null : receipt;
    if (url.includes('start.json')) return JSON.stringify({dataDate: '2026-10-01', slotId:'europe-regular-v1-2026-10-01-1790834400', sourceDate:'2026-09-30', execution: 'xuan-preopen-report-test'});
    if (url.includes('/executions/')) return JSON.stringify({completionTime: 'time', succeededCount: 1, taskCount: 1});
    return html;
  }, loadContext: async () => ({previousHtml:'old html'})});
  assert.equal(result.outcome,'generated');
});
test('repeated workflow uses the existing delivery and never regenerates; published bytes no-op', async () => {
  for (const previousHtml of ['old html',html]) {
    const result = await collectDelivery({now, request: async (url,options = {}) => {
      assert.notEqual(options.method,'POST'); return url.includes('receipt.json') ? receipt : html;
    }, loadContext: async () => ({previousHtml, previousSourceSha:'a'.repeat(40), previousMeta:{dataDate:'2026-10-01',sourceCommitEpoch:now()/1000,sourceSha:'a'.repeat(40),htmlBlob: crypto.createHash('sha1').update(Buffer.from(`blob ${Buffer.byteLength(html)}\0`)).update(html).digest('hex')}})});
    assert.equal(result.outcome,previousHtml === html ? 'already-published' : 'reused');
  }
});
test('a failed execution is not retried or substituted with old public data', async () => {
  let runs = 0;
  await assert.rejects(collectDelivery({now, request: async (url,options = {}) => {
    if (options.method === 'POST') {runs++; return JSON.stringify({metadata: {name: JOB+'/executions/test-run'}});}
    if (url.includes('/executions/')) return JSON.stringify({failedCount: 1});
    return null;
  }}), /EXECUTION_FAILED/); assert.equal(runs,1);
});
test('closed markets access no cloud endpoint or credentials', async () => {
  const result = await collectDelivery({now: () => Date.parse('2026-12-25T06:00:00Z'), request: async () => {throw new Error('must not call');}});
  assert.equal(result.outcome,'no-action');
});
test('permission failure never masquerades as a missing delivery', async () => {
  const oldFetch = global.fetch; global.fetch = async () => new Response('denied',{status: 403});
  try {await assert.rejects(deliveryTransport('test-identity')('https://storage.googleapis.com/', {missing: true}), /HTTP_403/);}
  finally {global.fetch = oldFetch;}
});
test('inactive season and late jobs check window before any identity or request', async () => {
  for(const time of ['2026-10-26T06:10:00Z','2026-10-05T07:01:00Z']) {
    const result=await collectDelivery({now:()=>Date.parse(time),request:async()=>{throw new Error('must not call');}});
    assert.equal(result.outcome,'outside-window');
  }
});
test('old root receipts never satisfy formal slot; stale or mismatched slot receipts fail', async()=>{
  for(const modify of [r=>delete r.slotId,r=>r.sourceDate='2026-09-29',r=>r.startedAt='2026-10-01T05:00:00Z',r=>delete r.readiness]) {
    const r=JSON.parse(receipt);modify(r);
    await assert.rejects(collectDelivery({now,request:async url=>url.includes('receipt.json')?JSON.stringify(r):html,
      loadContext:async()=>({previousHtml:html})}));
  }
});

test('fresh wrapper receipt cannot relabel early acceptance HTML as formal action report', async()=>{
  const model=extractNightActionModel(html);model.asOfHkt='2026-10-01 13:59 HKT · 数据至 2026-09-30';
  const early=renderNightActionReport(model),r=JSON.parse(receipt);
  r.artifact.sha256=crypto.createHash('sha256').update(early).digest('hex');
  await assert.rejects(collectDelivery({now,request:async url=>url.includes('receipt.json')?JSON.stringify(r):early,
    loadContext:async()=>({previousHtml:early})}),/MODEL_SOURCE_TIME/);
});
