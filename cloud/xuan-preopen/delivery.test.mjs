import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {collectDelivery, deliveryTransport} from './delivery.mjs';
const now = () => Date.parse('2026-10-01T05:00:00Z');
const JOB = 'projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report';
const receipt = JSON.stringify({status: 'ready', dataDate: '2026-10-01', sourceDate: '2026-09-30', artifact: {privateObject: 'delivery/2026-10-01/report.html',
  sha256: crypto.createHash('sha256').update('new html').digest('hex')}});
test('one run request is followed by exact execution status and completed private files', async () => {
  const calls = []; let reads = 0;
  const result = await collectDelivery({now, request: async (url,options = {}) => {
    calls.push({url,options});
    if (url.endsWith(':run')) return JSON.stringify({metadata: {name: JOB+'/executions/test-run'}});
    if (url.includes('/executions/')) return JSON.stringify({completionTime: 'time', succeededCount: 1, taskCount: 1});
    if (url.includes('receipt.json')) return ++reads === 1 ? null : receipt;
    if (url.includes('start.json')) return null;
    return 'new html';
  }, loadContext: async () => ({previousHtml: 'old html'})});
  assert.equal(result.outcome,'generated'); assert.equal(calls.filter(x => x.options.method === 'POST').length,1);
  assert.ok(calls.filter(x => x.url.includes('storage.googleapis')).every(x => x.url.includes('delivery%2F2026-10-01%2F')));
});
test('an incomplete earlier run is followed instead of starting a second job', async () => {
  let reads = 0;
  const result = await collectDelivery({now, request: async (url,options = {}) => {
    assert.notEqual(options.method,'POST');
    if (url.includes('receipt.json')) return ++reads === 1 ? null : receipt;
    if (url.includes('start.json')) return JSON.stringify({dataDate: '2026-10-01', execution: 'xuan-preopen-report-test'});
    if (url.includes('/executions/')) return JSON.stringify({completionTime: 'time', succeededCount: 1, taskCount: 1});
    return 'new html';
  }, loadContext: async () => ({previousHtml:'old html'})});
  assert.equal(result.outcome,'generated');
});
test('repeated workflow uses the existing delivery and never regenerates; published bytes no-op', async () => {
  for (const previousHtml of ['old html','new html']) {
    const result = await collectDelivery({now, request: async (url,options = {}) => {
      assert.notEqual(options.method,'POST'); return url.includes('receipt.json') ? receipt : 'new html';
    }, loadContext: async () => ({previousHtml})});
    assert.equal(result.outcome,previousHtml === 'new html' ? 'already-published' : 'reused');
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
const failureReceipt = () => ({schemaVersion: 1, status: 'failed', dataDate: '2026-10-01', sourceDate: '2026-09-30',
  execution: 'xuan-preopen-report-test', publication: 'none', errorCode: 'IB_REAUTHORIZE_REQUIRED'});
test('terminal execution failure reads its bounded private reason once and never launches another job', async () => {
  let reads = 0; const calls = [];
  await assert.rejects(collectDelivery({now, request: async (url,options = {}) => {
    calls.push({url,options}); assert.notEqual(options.method, 'POST');
    if (url.includes('receipt.json')) return ++reads === 1 ? null : JSON.stringify(failureReceipt());
    if (url.includes('start.json')) return JSON.stringify({dataDate: '2026-10-01', execution: 'xuan-preopen-report-test'});
    if (url.includes('/executions/')) return JSON.stringify({failedCount: 1});
    assert.fail('must not read report or sources');
  }}), /PREOPEN_DELIVERY_IB_REAUTHORIZE_REQUIRED/);
  assert.equal(reads, 2); assert.equal(calls.length, 4);
});
test('malformed, stale, extra-field and arbitrary-code failure receipts cannot leak details or authorize a report', async () => {
  for (const patch of [{dataDate: '2026-09-30'}, {sourceDate: '2026-09-29'}, {schemaVersion: 2},
    {execution: 'other-job-test'}, {publication: 'published'}, {errorCode: 'PRIVATE_TOKEN'}, {raw: 'private-source'}]) {
    let calls = 0;
    await assert.rejects(collectDelivery({now, request: async () => {
      calls++; return JSON.stringify({...failureReceipt(), ...patch});
    }, loadContext: async () => {assert.fail('must not load public report');}}), /^Error: PREOPEN_DELIVERY_RECEIPT$/);
    assert.equal(calls, 1);
  }
});
test('failure reason from another execution is rejected; cancellation and old images retain generic failure', async () => {
  for (const terminalReceipt of [null, {...failureReceipt(), execution: 'xuan-preopen-report-other'},
    {...failureReceipt(), errorCode: 'DAILY_REPORT_FAILED'}]) {
    let reads = 0;
    await assert.rejects(collectDelivery({now, request: async (url, options = {}) => {
      assert.notEqual(options.method, 'POST');
      if (url.includes('receipt.json')) return ++reads === 1 || terminalReceipt === null ? null : JSON.stringify(terminalReceipt);
      if (url.includes('start.json')) return JSON.stringify({dataDate: '2026-10-01', execution: 'xuan-preopen-report-test'});
      if (url.includes('/executions/')) return JSON.stringify({cancelledCount: 1});
      assert.fail('unexpected report access');
    }}), terminalReceipt?.execution === 'xuan-preopen-report-other' ? /PREOPEN_DELIVERY_RECEIPT/ : /PREOPEN_DELIVERY_EXECUTION_FAILED/);
    assert.equal(reads, 2);
  }
});
test('closed markets access no cloud endpoint or credentials', async () => {
  const result = await collectDelivery({now: () => Date.parse('2026-12-25T05:00:00Z'), request: async () => {throw new Error('must not call');}});
  assert.equal(result.outcome,'no-action');
});
test('permission failure never masquerades as a missing delivery', async () => {
  const oldFetch = global.fetch; global.fetch = async () => new Response('denied',{status: 403});
  try {await assert.rejects(deliveryTransport('test-identity')('https://storage.googleapis.com/', {missing: true}), /HTTP_403/);}
  finally {global.fetch = oldFetch;}
});
