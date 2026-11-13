import test from 'node:test';
import assert from 'node:assert/strict';
import {createIntakeHandler, readConfig} from './fee-manager-refresh-entry.mjs';
import {handleIntake, ALLOWED_ORIGIN} from './fee-manager-refresh-server.mjs';

const env = mode => ({FEE_REFRESH_MODE:mode, FEE_REFRESH_GIST_ID:'a'.repeat(32),
  FEE_REFRESH_QUEUE_BUCKET:'synthetic-queue-acceptance', FEE_REFRESH_STATUS_BUCKET:'synthetic-status-acceptance',
  FEE_REFRESH_JOB:'projects/family-portfolio-gateway/locations/asia-east2/jobs/fee-refresh-launch-acceptance'});
const request = (over = {}) => ({method:'GET', path:'/v1/mode', headers:{origin:ALLOWED_ORIGIN}, ...over});
test('mode endpoint uses validated runtime mode and touches no resource or credential', async () => {
  for (const mode of ['acceptance','launch']) {
    const input = env(mode);
    if (mode === 'launch') { input.FEE_REFRESH_QUEUE_BUCKET='synthetic-queue'; input.FEE_REFRESH_STATUS_BUCKET='synthetic-status';
      // Start-up job-name isolation: a launch intake may not name the acceptance job.
      assert.throws(() => readConfig(input, 'serve'), /CONFIG/);
      input.FEE_REFRESH_JOB = input.FEE_REFRESH_JOB.replace(/-acceptance$/, ''); }
    const config = readConfig(input, 'serve'); let calls = 0;
    const handler = createIntakeHandler(config, {http:async () => {calls++; throw Error('NO_IO');}});
    const r = await handler(request({body:'{"mode":"launch","token":"not-real"}', mode:'disabled'}));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), {schema:'fee-console.manager-refresh-mode.v1', mode});
    assert.equal(r.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
    assert.equal(r.headers['Cache-Control'], 'no-store'); assert.equal(r.headers.Vary, 'Origin');
    assert.equal(calls, 0);
  }
});
test('mode retains exact Origin policy, method routing and default-disabled refusal', async () => {
  const handler = createIntakeHandler(readConfig(env('acceptance'), 'serve'), {http:async () => {throw Error('NO_IO');}});
  for (const origin of [undefined, 'null', ALLOWED_ORIGIN+'/', 'https://invalid.example']) {
    const r = await handler(request({headers:{origin}})); assert.equal(r.status, 403); assert.equal(r.body, '');
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
  }
  assert.equal((await handler(request({method:'POST'}))).status, 404);
  assert.equal((await handler(request({path:'/v1/mode/'}))).status, 404);
  const disabled = createIntakeHandler(readConfig({}, 'serve'), {});
  assert.deepEqual(JSON.parse((await disabled(request())).body), {code:'INTAKE_NOT_ACTIVE'});
  assert.equal((await disabled(request())).status, 503);
  for (const mode of [undefined, 'unknown', 'disabled']) {
    const r = await handleIntake(request(), {mode}); assert.equal(r.status, 503);
  }
});
test('mode is gated by the existing configuration validator and is not supplied by the caller', async () => {
  assert.throws(() => readConfig(env('unknown'), 'serve'), /CONFIG/);
  const input = env('acceptance'); input.FEE_REFRESH_LEDGER_BUCKET='synthetic-ledger-acceptance';
  assert.throws(() => readConfig(input, 'serve'), /CONFIG/);
  const config = readConfig(env('acceptance'), 'serve');
  const handler = createIntakeHandler(config, {http:async () => {throw Error('NO_IO');}});
  assert.equal(JSON.parse((await handler(request({query:{mode:'launch'}}))).body).mode, 'acceptance');
});
