import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaily} from './daily.mjs';
import {collectDelivery} from './delivery.mjs';
test('joint holiday never loads credentials or reads financial sources', async () => {
  const saved = []; let generated = false;
  const result = await runDaily({now: () => Date.parse('2026-12-25T05:00:00Z'), io: {savePrivate: async (name,value) => saved.push({name,value})},
    generate: async () => {generated = true;}});
  assert.equal(generated, false); assert.equal(result.status, 'no-action'); assert.equal(saved.length, 1);
});
test('delivery exposes only HTML and completion receipt, written in that order', async () => {
  const saved = [], io = {savePrivate: async (name,value) => {saved.push({name,value}); return {sha256: 'a'.repeat(64), generation: '1'};}};
  await runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test', io, generate: async ({sourceDate,io: wrapped}) => {
    assert.equal(sourceDate,'2026-09-30'); await wrapped.savePrivate('report-check/id/report.html','private html');
    return {status: 'ready', artifact: {}, dataDate: '2026-10-01', sourceDate};
  }});
  assert.deepEqual(saved.map(x => x.name), ['delivery/2026-10-01/start.json','report-check/id/report.html','delivery/2026-10-01/report.html','delivery/2026-10-01/receipt.json']);
});
test('partial generation creates only a failed terminal receipt, never a ready delivery', async () => {
  const saved = [];
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test', io: {savePrivate: async name => saved.push(name)},
    generate: async () => ({status: 'partial'})}), /INCOMPLETE/);
  assert.deepEqual(saved,['delivery/2026-10-01/start.json','delivery/2026-10-01/receipt.json']);
});
test('an existing daily start marker blocks duplicate financial generation', async () => {
  let generated = false;
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test',
    io: {savePrivate: async () => {throw new Error('CLOUD_HTTP_412');}}, generate: async () => {generated = true;}}), /412/);
  assert.equal(generated,false);
});
test('source reauthorization failure crosses the private handoff without credentials, retry or publication', async () => {
  const objects = new Map(), now = () => Date.parse('2026-10-01T05:00:00Z');
  const failure = new Error('IB_REAUTHORIZE_REQUIRED'); let generations = 0;
  const io = {savePrivate: async (name,value) => {
    if (objects.has(name)) throw new Error('CLOUD_HTTP_412');
    objects.set(name, JSON.stringify(value));
  }};
  const generate = async () => {generations++; throw failure;};
  await assert.rejects(runDaily({now, io, generate, execution: 'xuan-preopen-report-test'}), error => error === failure);
  const receipt = JSON.parse(objects.get('delivery/2026-10-01/receipt.json'));
  assert.deepEqual(receipt, {schemaVersion: 1, status: 'failed', dataDate: '2026-10-01', sourceDate: '2026-09-30',
    execution: 'xuan-preopen-report-test', publication: 'none', errorCode: 'IB_REAUTHORIZE_REQUIRED'});
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(collectDelivery({now, request: async (url,options = {}) => {
      assert.notEqual(options.method, 'POST');
      assert.ok(url.includes('receipt.json'));
      return objects.get('delivery/2026-10-01/receipt.json');
    }, loadContext: async () => {assert.fail('must not load old public report');}}), /PREOPEN_DELIVERY_IB_REAUTHORIZE_REQUIRED/);
  }
  await assert.rejects(runDaily({now, io, generate, execution: 'xuan-preopen-report-loser'}), /CLOUD_HTTP_412/);
  assert.equal(generations, 1);
  assert.equal(objects.size, 2);
});
test('unknown source errors are reduced to one fixed code and receipt write errors preserve the original failure', async () => {
  const failure = new Error('PRIVATE_TOKEN_ACCOUNT_AMOUNT'), now = () => Date.parse('2026-10-01T05:00:00Z');
  for (const storageFails of [false, true]) {
    const saved = [];
    await assert.rejects(runDaily({now, execution: 'xuan-preopen-report-test', generate: async () => {throw failure;},
      io: {savePrivate: async (name,value) => {
        saved.push({name,value});
        if (storageFails && name.endsWith('receipt.json')) throw new Error('CLOUD_HTTP_403');
      }}}), error => error === failure);
    assert.equal(saved[1].value.errorCode, 'DAILY_REPORT_FAILED');
    assert.ok(!JSON.stringify(saved).includes(failure.message));
  }
});

import {loadReadCredential, IbReadSession, RESOURCE} from './ib_mcp.mjs';
import {dailyFailureSummary} from './daily.mjs';
import {deliveryFailureSummary} from './delivery.mjs';
const cases = [[400,'invalid_grant','IB_REFRESH_INVALID_GRANT'], [400,'invalid_client','IB_REFRESH_CLIENT_REJECTED'],
  [400,'invalid_scope','IB_REFRESH_SCOPE_REJECTED'], [429,'unknown','IB_REFRESH_TRANSIENT_FAILED'],
  [400,'unknown','IB_REFRESH_HTTP_FAILED'], [401,'mcp','IB_MCP_ACCESS_TOKEN_REJECTED'],
  [403,'mcp','IB_MCP_ACCESS_FORBIDDEN'], [503,'mcp','IB_MCP_HTTP_FAILED']];
for (const [status, category, code] of cases) test(`real mocked IB transport crosses Daily/delivery safely: ${code}`, async () => {
  const objects = new Map(), now = () => Date.parse('2026-10-01T05:00:00Z'); let calls = 0;
  const credential = {client_id:'canary-client',access_token:'canary-access',refresh_token:'canary-refresh',
    scope:'mcp.read',resource:RESOURCE,token_type:'Bearer',expires_at:1};
  const fetchImpl = async () => {calls++; return new Response(JSON.stringify({error: category,
    error_description:'SYNTHETIC_SECRET_CANARY',access_token:'SYNTHETIC_SECRET_CANARY'}), {status});};
  let sourceError;
  await assert.rejects(runDaily({now, execution:'xuan-preopen-report-test', io:{savePrivate:async (key,value)=>objects.set(key,JSON.stringify(value))},
    generate:async () => {
      try {
        if (category !== 'mcp') await loadReadCredential({load:async()=>credential,save:async()=>assert.fail('no save')},{fetchImpl,now});
        else {const session = new IbReadSession(credential,{fetchImpl}); await session.initialize();}
      } catch (error) {sourceError=error; throw error;}
    }}), error=>error.message===code);
  const receipt = JSON.parse(objects.get('delivery/2026-10-01/receipt.json'));
  assert.equal(receipt.schemaVersion,2); assert.equal(receipt.errorCode,code); assert.equal(calls,1);
  await assert.rejects(collectDelivery({now,request:async (url,options={})=>{
    assert.notEqual(options.method,'POST'); assert.ok(url.includes('receipt.json')); return JSON.stringify(receipt);
  },loadContext:async()=>assert.fail('no source or HTML')}), error=>{
    assert.equal(error.message,'PREOPEN_DELIVERY_'+code);
    assert.deepEqual(error.diagnostic,sourceError.diagnostic);
    assert.ok(!JSON.stringify([receipt,dailyFailureSummary(sourceError),deliveryFailureSummary(error)]).includes('CANARY'));
    return true;
  });
});
test('unknown codes and malformed or extra diagnostics reduce safely in Daily and its CLI', async () => {
  for (const error of [Object.assign(new Error('IB_REFRESH_INVALID_GRANT'), {diagnostic:{phase:'refresh',httpStatus:401,oauthError:'invalid_grant'}}),
    Object.assign(new Error('IB_REFRESH_INVALID_GRANT'), {diagnostic:{phase:'refresh',httpStatus:400,oauthError:'invalid_grant',raw:'CANARY'}}),
    new Error('UNKNOWN_CANARY')]) {
    const saved=[];
    await assert.rejects(runDaily({now:()=>Date.parse('2026-10-01T05:00:00Z'),execution:'xuan-preopen-report-test',
      io:{savePrivate:async(key,value)=>saved.push(value)},generate:async()=>{throw error;}}),actual=>actual===error);
    assert.equal(saved[1].errorCode,'DAILY_REPORT_FAILED'); assert.equal(saved[1].schemaVersion,1);
    assert.deepEqual(dailyFailureSummary(error),{status:'failed',code:'DAILY_REPORT_FAILED',publication:'none'});
  }
});
