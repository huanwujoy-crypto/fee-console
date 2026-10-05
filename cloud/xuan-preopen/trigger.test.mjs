import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runTrigger, triggerTransport} from './trigger.mjs';

const now = () => Date.parse('2026-10-05T05:10:00Z');
const empty = {total_count: 0, workflow_runs: []};
const row = (status = 'in_progress', overrides = {}) => ({id: 7, head_branch: 'main', event: 'workflow_dispatch',
  created_at: '2026-10-05T05:00:01Z', run_started_at: '2026-10-05T05:00:05Z', status, ...overrides});
const result = rows => ({total_count: rows.length, workflow_runs: rows});
function fakeRequest(data = empty) {
  const calls = [];
  return {calls, request: async (suffix, options) => {calls.push({suffix, options}); return suffix === '/dispatches' ? null : data;}};
}
test('launch queries the full HKT day, then dispatches exactly one fixed main workflow', async () => {
  const mock = fakeRequest();
  assert.equal((await runTrigger({mode: 'launch', now, request: mock.request})).outcome, 'requested');
  assert.equal(mock.calls[0].suffix, '/runs?branch=main&created=2026-10-04T16%3A00%3A00Z..2026-10-05T15%3A59%3A59Z&per_page=100');
  assert.deepEqual(mock.calls[1], {suffix: '/dispatches', options: {method: 'POST', body: {ref: 'main'}}});
  assert.equal(mock.calls.length, 2);
});
test('any already requested current-day main run prevents another dispatch', async () => {
  for (const status of ['queued', 'requested', 'pending', 'waiting', 'in_progress', 'completed']) {
    const mock = fakeRequest(result([row(status)]));
    assert.equal((await runTrigger({mode: 'launch', now, request: mock.request})).outcome, 'already-requested');
    assert.equal(mock.calls.length, 1);
  }
});
test('old-date and other-branch runs do not suppress a current-day main request', async () => {
  const mock = fakeRequest(result([row('completed', {created_at: '2026-10-04T15:59:59Z', run_started_at: '2026-10-04T16:00:01Z'}),
    row('queued', {head_branch: 'unrelated'})]));
  assert.equal((await runTrigger({mode: 'launch', now, request: mock.request})).outcome, 'requested');
});
test('watchdog requires actual start, never treats queued/requested/waiting as started', async () => {
  for (const status of ['queued', 'requested', 'pending', 'waiting']) {
    const mock = fakeRequest(result([row(status)]));
    await assert.rejects(runTrigger({mode: 'check-start', now, request: mock.request}), /NOT_STARTED/);
    assert.equal(mock.calls.length, 1);
  }
  for (const status of ['in_progress', 'completed']) {
    const mock = fakeRequest(result([row(status)]));
    assert.equal((await runTrigger({mode: 'check-start', now, request: mock.request})).outcome, 'started');
  }
  await assert.rejects(runTrigger({mode: 'check-start', now, request: fakeRequest().request}), /NOT_STARTED/);
});
test('truncated, malformed, future or impossible-start run lists fail closed without dispatch', async () => {
  for (const data of [{total_count: 101, workflow_runs: []}, {total_count: 1, workflow_runs: []}, {},
    result([{}]), result([row('unknown')]), result([row('queued', {created_at: '2026-10-05T06:00:00Z'})]),
    result([row('in_progress', {run_started_at: null})]), result([row('completed', {run_started_at: '2026-10-04T01:00:00Z'})]),
    result([row('completed', {run_started_at: '2026-10-05T06:00:00Z'})])]) {
    const mock = fakeRequest(data);
    await assert.rejects(runTrigger({mode: 'launch', now, request: mock.request}), /RUNS_/);
    assert.equal(mock.calls.length, 1);
  }
});
test('official joint closures take no action; unreviewed calendar years fail closed', async () => {
  for (const instant of ['2026-10-03T05:00:00Z', '2026-12-25T05:00:00Z']) {
    const mock = fakeRequest();
    assert.equal((await runTrigger({mode: 'launch', now: () => Date.parse(instant), request: mock.request})).outcome, 'no-action');
    assert.equal(mock.calls.length, 0);
  }
  await assert.rejects(runTrigger({mode: 'launch', now: () => Date.parse('2027-01-04T05:00:00Z'), request: fakeRequest().request}), /CALENDAR/);
});
test('late/early launches and invalid modes never call GitHub', async () => {
  for (const instant of ['2026-10-05T04:59:59Z', '2026-10-05T05:20:00Z']) {
    const mock = fakeRequest();
    await assert.rejects(runTrigger({mode: 'launch', now: () => Date.parse(instant), request: mock.request}), /OUTSIDE_WINDOW/);
    assert.equal(mock.calls.length, 0);
  }
  await assert.rejects(runTrigger({mode: 'check-start', now: () => Date.parse('2026-10-05T05:04:59Z'), request: fakeRequest().request}), /CHECK_TOO_EARLY/);
  await assert.rejects(runTrigger({mode: 'publish', now, request: fakeRequest().request}), /MODE/);
});
test('unknown dispatch result is not retried', async () => {
  let posts = 0;
  await assert.rejects(runTrigger({mode: 'launch', now, request: async suffix => {
    if (suffix !== '/dispatches') return empty;
    posts++; throw new Error('PREOPEN_TRIGGER_NETWORK');
  }}), /NETWORK/);
  assert.equal(posts, 1);
});

function transportMock({secret = 'test-only-actions-token', failAt, status = 204, dispatchBody = {}} = {}) {
  const calls = [];
  const request = triggerTransport({fetchImpl: async (url, init) => {
    calls.push({url, init});
    if (calls.length === failAt) throw new Error('do-not-leak-test-token');
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({access_token: 'test-only-google-token'});
    if (url.startsWith('https://secretmanager.googleapis.com/')) return Response.json({payload: {data: Buffer.from(secret).toString('base64')}});
    if (url.endsWith('/dispatches')) return status === 200 ? Response.json(dispatchBody) : new Response(null, {status});
    return Response.json(empty);
  }});
  return {request, calls};
}
test('encoded date-range transport works end-to-end, reads only the dedicated Actions credential', async () => {
  const mock = transportMock();
  assert.equal((await runTrigger({mode: 'launch', now, request: mock.request})).outcome, 'requested');
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls[1].url, 'https://secretmanager.googleapis.com/v1/projects/family-portfolio-gateway/secrets/xuan-preopen-trigger-github/versions/latest:access');
  assert.ok(mock.calls[2].url.startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/xuan-preopen-cloud-producer.yml/runs?'));
  assert.equal(mock.calls[3].url, 'https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/xuan-preopen-cloud-producer.yml/dispatches');
  assert.equal(mock.calls[3].init.body, '{"ref":"main"}');
  assert.ok(mock.calls.every(call => call.init.redirect === 'error'));
});
test('transport rejects caller-selected paths, branch, query, methods and overrides before credentials are read', async () => {
  const valid = '/runs?branch=main&created=2026-10-04T16%3A00%3A00Z..2026-10-05T15%3A59%3A59Z&per_page=100';
  for (const [suffix, options] of [['/runs?branch=main&created=2026-10-05&per_page=100', {}],
    [valid.replace('main', 'elsewhere'), {}], [valid+'&url=https://evil.test', {}], ['/other', {}],
    ['/dispatches', {method: 'POST', body: {ref: 'main', inputs: {force: true}}}], ['/dispatches', {}],
    [valid, {method: 'POST'}], [valid, {body: {}}], ['/dispatches', {method: 'POST', body: {ref: 'other'}}]]) {
    const mock = transportMock();
    await assert.rejects(mock.request(suffix, options), /SCOPE/);
    assert.equal(mock.calls.length, 0);
  }
});
test('transport sanitizes network failures and rejects malformed credentials and unexpected POST status', async () => {
  for (const secret of ['', 'test\ntoken', 'test\rtoken']) {
    const mock = transportMock({secret});
    await assert.rejects(runTrigger({mode: 'launch', now, request: mock.request}), /CREDENTIAL/);
    assert.equal(mock.calls.length, 2);
  }
  for (const failAt of [1, 2, 3, 4]) {
    const mock = transportMock({failAt});
    await assert.rejects(runTrigger({mode: 'launch', now, request: mock.request}), /^Error: PREOPEN_TRIGGER_NETWORK$/);
    assert.equal(mock.calls.length, failAt);
  }
  await assert.rejects(runTrigger({mode: 'launch', now, request: transportMock({status: 200}).request}), /DISPATCH_RESPONSE/);
});
test('a newer 200 dispatch receipt must name a valid run in exactly the fixed repository', async () => {
  const valid = {workflow_run_id: 7, run_url: 'https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs/7',
    html_url: 'https://github.com/huanwujoy-crypto/fee-console/actions/runs/7'};
  assert.equal((await runTrigger({mode: 'launch', now, request: transportMock({status: 200, dispatchBody: valid}).request})).outcome, 'requested');
  for (const dispatchBody of [{...valid, workflow_run_id: -1}, {...valid, html_url: 'https://evil.test'},
    {...valid, run_url: valid.run_url.replace('fee-console', 'other')}]) {
    await assert.rejects(runTrigger({mode: 'launch', now, request: transportMock({status: 200, dispatchBody}).request}), /DISPATCH_RESPONSE/);
  }
});
test('trigger image contains only the clock and its two helpers, not financial/producer/publisher executables', () => {
  const docker = readFileSync(new URL('./Trigger.Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /USER node/);
  assert.match(docker, /trigger\.mjs.*calendar\.mjs.*cloud_io\.mjs/s);
  assert.doesNotMatch(docker, /daily\.mjs|delivery\.mjs|publish\.mjs|ib_mcp|scripts\/|COPY \. /);
});
