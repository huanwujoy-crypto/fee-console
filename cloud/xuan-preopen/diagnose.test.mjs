import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {collectDiagnostic, diagnosticTransport, runDiagnosticCli, validateDiagnosticDate} from './diagnose.mjs';

const now = () => Date.parse('2026-10-09T05:00:00Z');
const dataDate = '2026-10-09', execution = 'xuan-preopen-report-synthetic';
const name = `projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report/executions/${execution}`;
const start = {dataDate, execution, startedAt: '2026-10-09T04:59:00.000Z'};
const canary = 'private-amount-1234567-token-do-not-print';
const ready = {schemaVersion: 1, status: 'ready', dataDate, artifact: {privateObject: `delivery/${dataDate}/report.html`}, sources: [canary]};
const failed = {schemaVersion: 1, status: 'failed', dataDate, sourceDate: '2026-10-08', execution, publication: 'none', errorCode: 'IB_REAUTHORIZE_REQUIRED'};

function recording({marker = start, receipt = null, status = {name, failedCount: 1}, overrides = {}} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (overrides.response) return overrides.response();
    const value = url.includes('start.json') ? marker : url.includes('receipt.json') ? receipt : status;
    return value === null ? new Response(canary, {status: 404}) : Response.json(value);
  };
  return {calls, fetchImpl, options: {dataDate, now, token: 'synthetic-google-token', fetchImpl}};
}

test('exact real calendar date fixed to HKT today, including UTC crossover', () => {
  assert.equal(validateDiagnosticDate(dataDate, now), dataDate);
  assert.equal(validateDiagnosticDate('2026-10-10', () => Date.parse('2026-10-09T16:00:00Z')), '2026-10-10');
  for (const date of ['2026-10-08', '2026-09-25', '2026-10-10', '2026-02-30', '2026-13-01', '2026-1-09', `${dataDate}\n`, '../secret', '', null]) {
    assert.throws(() => validateDiagnosticDate(date, now), /DIAGNOSTIC_DATE/);
  }
  assert.equal(validateDiagnosticDate('2028-02-29', () => Date.parse('2028-02-29T00:00:00Z')), '2028-02-29');
});

test('CLI rejects date overrides and unknown modes before reading identity or cloud', async () => {
  let identities = 0;
  const env = {get XUAN_PREOPEN_GOOGLE_TOKEN() { identities++; throw new Error(canary); }};
  let output = '';
  for (const args of [[dataDate], ['--check-inputs'], ['--today', dataDate], ['--today', '--limited-prefix', canary], []]) {
    assert.equal(await runDiagnosticCli(args, {env, now, stderr: text => output += text}), 1);
  }
  assert.equal(identities, 0); assert.equal(output, 'PREOPEN_DIAGNOSTIC_INPUTS\n'.repeat(5));
});

test('real transport emits at most three exact GET routes with execution field mask excluding config and messages', async () => {
  const fixture = recording({status: {name, failedCount: 1, template: {env: canary}, conditions: [{message: canary}]}});
  const result = await collectDiagnostic(fixture.options);
  assert.deepEqual(result, {event: 'PREOPEN_DIAGNOSTIC', status: 'execution-failed', dataDate, code: 'EXECUTION_FAILED_RECEIPT_MISSING', diagnostic: 'root-cause-unknown'});
  assert.equal(fixture.calls.length, 3);
  assert.deepEqual(fixture.calls.slice(0, 2).map(call => call.url), ['start.json', 'receipt.json'].map(file =>
    `https://storage.googleapis.com/storage/v1/b/family-portfolio-gateway-xuan-preopen-private/o/delivery%2F2026-10-09%2F${file}?alt=media`));
  const url = new URL(fixture.calls[2].url);
  assert.equal(url.pathname, `/v2/${name}`);
  assert.equal(url.searchParams.get('fields'), 'name,completionTime,taskCount,succeededCount,failedCount,cancelledCount,retriedCount');
  assert.ok(fixture.calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error' && !call.options.body));
  assert.ok(!JSON.stringify(result).includes(canary));
});

test('transport rejects HTML, source paths, lists, traversal, another job and unbounded execution IDs locally', async () => {
  const fixture = recording(), io = diagnosticTransport(fixture.options);
  for (const file of ['report.html', 'report-check/a/receipt.json', '../start.json', '', 'delivery/2026-10-09/start.json']) {
    assert.throws(() => io.readObject(file), /INPUTS/);
  }
  for (const id of ['other-job-run', `${execution}/tasks`, `${execution}?fields=template`, `${execution}\n`, 'xuan-preopen-report-' + 'a'.repeat(97)]) {
    assert.throws(() => io.readExecution(id), /START/);
  }
  assert.equal(fixture.calls.length, 0);
});

test('strict start binds date, timestamp, execution and exact keys; a bad marker cannot choose an execution', async () => {
  for (const marker of [{...start, dataDate: '2026-10-08'}, {...start, startedAt: '2026-10-09T06:00:00Z'},
    {...start, startedAt: '2026-10-08T04:59:00Z'}, {...start, execution: 'another-job'}, {...start, arbitrary: canary},
    {...start, startedAt: '2026-02-30T04:59:00Z'}, [], canary]) {
    const fixture = recording({marker});
    await assert.rejects(collectDiagnostic(fixture.options), /START/);
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = recording({marker: {...start, startedAt: '2026-10-09T04:59:00Z'}});
  assert.equal((await collectDiagnostic(fixture.options)).status, 'execution-failed');
});

test('v1/v2 failures and successful/no-action receipts rebuild safe summaries without echoing receipt diagnostics', async () => {
  for (const [receipt, code] of [[failed, 'IB_REAUTHORIZE_REQUIRED'], [{...failed, errorCode: canary}, 'FAILURE_RECEIPT_PRESENT'],
    [{...failed, schemaVersion: 2, errorCode: 'IB_REFRESH_INVALID_GRANT', diagnostic: {phase: canary, httpStatus: canary, oauthError: canary}}, 'FAILURE_RECEIPT_PRESENT'],
    [ready, 'COMPLETION_RECEIPT_PRESENT'], [{status: 'no-action', dataDate, reason: canary}, 'NO_ACTION_RECEIPT_PRESENT']]) {
    const fixture = recording({receipt}), result = await collectDiagnostic(fixture.options);
    assert.equal(result.code, code); assert.equal(fixture.calls.length, 2); assert.ok(!JSON.stringify(result).includes(canary));
    assert.ok(!JSON.stringify(result).includes(execution));
  }
  for (const receipt of [{...failed, execution: 'xuan-preopen-report-other'}, {...failed, rawMessage: canary},
    {...failed, sourceDate: dataDate}, {...ready, dataDate: '2026-10-08'}, {...ready, schemaVersion: 3}, {...ready, artifact: {privateObject: 'report-check/id/report.html'}}]) {
    await assert.rejects(collectDiagnostic(recording({receipt}).options), /RESPONSE/);
  }
});

test('missing execution and receipts remain unknown; running/success/cancel cannot masquerade as completed report', async () => {
  const cases = [
    [{marker: null}, 'unknown'], [{status: null}, 'unknown'], [{status: {name, taskCount: 1}}, 'running'],
    [{status: {name, cancelledCount: 1}}, 'execution-failed'],
    [{status: {name, completionTime: '2026-10-09T05:00:00Z', succeededCount: 1, taskCount: 1}}, 'execution-succeeded-receipt-missing'],
    [{status: {name, completionTime: '2026-10-09T05:00:00Z', succeededCount: 1, taskCount: 1, retriedCount: 1}}, 'unknown'],
  ];
  for (const [options, expected] of cases) {
    const fixture = recording(options), result = await collectDiagnostic(fixture.options); assert.equal(result.status, expected);
    if (options.marker === null) assert.equal(result.diagnostic, 'evidence-missing');
    assert.equal(fixture.calls.length, options.marker === null ? 2 : 3);
  }
  for (const status of [{name: name.replace('xuan-preopen-report/', 'other-job/'), failedCount: 1}, {name, failedCount: canary},
    {name, succeededCount: -1}, {name, completionTime: canary}]) await assert.rejects(collectDiagnostic(recording({status}).options), /EXECUTION/);
});

test('legacy merged broker error is evidence only and cannot establish a reauthorization remedy', async () => {
  const fixture = recording({receipt: failed}), result = await collectDiagnostic(fixture.options);
  assert.equal(result.status, 'receipt-failed');
  assert.equal(result.code, 'IB_REAUTHORIZE_REQUIRED');
  assert.equal(result.diagnostic, 'root-cause-unknown');
  assert.equal(fixture.calls.length, 2);
  assert.ok(!JSON.stringify(result).includes('broker-reauthorization-required'));
});

test('execution completion must be a real UTC instant between the start marker and now', async () => {
  for (const completionTime of ['2026-02-30T05:00:00Z', '2099-01-01T00:00:00Z', '2026-10-09T04:58:59.999999999Z',
    '2026-10-09T05:00:00.000000001Z', '2026-10-09T25:00:00Z', '2026-10-09T05:00:00+00:00', '2026-10-09T05:00:00Z\n']) {
    const fixture = recording({status: {name, failedCount: 1, completionTime}});
    await assert.rejects(collectDiagnostic(fixture.options), /^Error: PREOPEN_DIAGNOSTIC_EXECUTION$/);
    assert.equal(fixture.calls.length, 3);
  }
  for (const completionTime of [start.startedAt, '2026-10-09T04:59:59.123456789Z', '2026-10-09T05:00:00Z']) {
    assert.equal((await collectDiagnostic(recording({status: {name, failedCount: 1, completionTime}}).options)).status, 'execution-failed');
  }
});

test('access, redirect, network, malformed and oversized responses fail closed once without raw private errors', async () => {
  for (const response of [() => new Response(canary, {status: 403}), () => new Response(canary, {status: 401}),
    () => new Response(canary, {status: 500}), () => new Response(canary, {status: 302}), () => new Response(canary),
    () => new Response('x'.repeat(4097)), () => new Response(new Uint8Array([0xff]))]) {
    const fixture = recording({overrides: {response}});
    await assert.rejects(collectDiagnostic(fixture.options), /PREOPEN_DIAGNOSTIC_(ACCESS_DENIED|CLOUD_READ_FAILED|RESPONSE)/);
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = recording(); fixture.options.fetchImpl = async () => { throw new Error(canary); };
  await assert.rejects(collectDiagnostic(fixture.options), /^Error: PREOPEN_DIAGNOSTIC_CLOUD_READ_FAILED$/);
});

test('each allowed route has its own byte bound and does not retry a too-large response', async () => {
  for (const [route, limit] of [['start.json', 4096], ['receipt.json', 65536], ['execution', 8192]]) {
    let calls = 0;
    const io = diagnosticTransport({dataDate, now, token: 'synthetic-token', fetchImpl: async () => {
      calls++; return new Response('x'.repeat(limit + 1));
    }});
    await assert.rejects(route === 'execution' ? io.readExecution(execution) : io.readObject(route), /^Error: PREOPEN_DIAGNOSTIC_RESPONSE$/);
    assert.equal(calls, 1);
  }
});

test('CLI exposes constructed status only, writes no private files, and validates before token/cloud use', async () => {
  const fixture = recording({receipt: ready}), stdout = [], stderr = [], appended = [];
  const env = {XUAN_PREOPEN_GOOGLE_TOKEN: 'synthetic-token', GITHUB_STEP_SUMMARY: 'synthetic-summary'};
  const options = {env, now, fetchImpl: fixture.fetchImpl, stdout: text => stdout.push(text), stderr: text => stderr.push(text),
    append: (file, text) => appended.push({file, text})};
  assert.equal(await runDiagnosticCli(['--today'], options), 0);
  assert.equal(stderr.length, 0); assert.equal(appended.length, 1); assert.equal(appended[0].text, stdout[0]);
  assert.ok(!stdout.join('').includes(canary));
  fixture.calls.length = 0;
  const invalidEnv = {get XUAN_PREOPEN_GOOGLE_TOKEN() { throw new Error(canary); }};
  assert.equal(await runDiagnosticCli(['../private'], {...options, env: invalidEnv}), 1);
  assert.equal(fixture.calls.length, 0); assert.ok(!stderr.join('').includes(canary));
  const crossed = recording({marker: null, receipt: null});
  const crossedOutput = [];
  assert.equal(await runDiagnosticCli(['--today'], {...options, env: {...env, DIAGNOSTIC_DATE: canary}, now: () => Date.parse('2026-10-09T16:00:00Z'),
    fetchImpl: crossed.fetchImpl, stdout: text => crossedOutput.push(text)}), 0);
  assert.equal(JSON.parse(crossedOutput[0]).dataDate, '2026-10-10');
  assert.ok(crossed.calls.every(call => call.url.includes('delivery%2F2026-10-10%2F')));
  for (const args of [[], ['--unknown'], [dataDate, 'extra']]) {
    const cli = spawnSync(process.execPath, [new URL('./diagnose.mjs', import.meta.url).pathname, ...args], {env: {}, encoding: 'utf8'});
    assert.equal(cli.status, 1); assert.equal(cli.stderr, 'PREOPEN_DIAGNOSTIC_INPUTS\n'); assert.equal(cli.stdout, '');
  }
});

const workflow = fs.readFileSync(new URL('../../.github/workflows/xuan-preopen-cloud-producer.yml', import.meta.url), 'utf8');
const stepBlocks = [...workflow.matchAll(/^      - name: (.+)\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/gm)].map(match => ({name: match[1], body: match[2]}));
function evaluate(expression, context) {
  const normalized = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const explicitStatus = /\b(?:failure|always)\(\)/.test(normalized);
  return Boolean(Function('github', 'inputs', 'vars', 'steps', 'always', 'failure', `return (${normalized});`)(
    context.github, context.inputs, context.vars, context.steps, () => true, () => context.failed))
    && (explicitStatus || !context.failed);
}
const step = fragment => { const result = stepBlocks.find(item => item.name.includes(fragment)); assert.ok(result, fragment); return result; };
const condition = item => item.body.match(/^        if: (.+)$/m)?.[1] || '${{ true }}';

test('workflow adds only automatic full-delivery failure diagnosis and preserves production gates', () => {
  const jobIf = workflow.match(/^    if: (.+)$/m)[1];
  assert.match(workflow, /environment: fee-cloud-producer/);
  assert.match(workflow, /providers\/xuan-preopen-main/);
  assert.match(workflow, /service_account: xuan-preopen-delivery@family-portfolio-gateway\.iam\.gserviceaccount\.com/);
  assert.match(workflow, /group: xuan-preopen-cloud-producer\n  cancel-in-progress: false/);
  assert.equal((workflow.match(/cron:/g) || []).length, 1);
  assert.doesNotMatch(workflow, /run-name:|diagnostic_date:|operation:|--check-inputs/);
  const diagnostic = step('Diagnose failed');
  assert.equal(condition(diagnostic), "${{ failure() && steps.delivery.outcome == 'failure' }}");
  assert.match(diagnostic.body, /run: node cloud\/xuan-preopen\/diagnose\.mjs --today/);
  assert.doesNotMatch(diagnostic.body, /inputs\.|continue-on-error|GITHUB_TOKEN|diagnostic_date/);
  assert.ok(workflow.indexOf('id: delivery') < workflow.indexOf('Diagnose failed'));
  assert.ok(workflow.indexOf('Diagnose failed') < workflow.indexOf('Submit the signed'));
  for (const mode of ['off', 'shadow', 'publish']) for (const event of ['schedule', 'workflow_dispatch']) {
    const context = {github: {ref: 'refs/heads/main', event_name: event}, inputs: {private_limited_readback_prefix: ''},
      vars: {XUAN_PREOPEN_CLOUD_MODE: mode}, failed: false, steps: {delivery: {outcome: 'success', outputs: {outcome: 'generated'}},
        limited: {outcome: 'skipped', outputs: {}}, candidate: {outputs: {sha: 'synthetic-sha'}}}};
    assert.equal(evaluate(jobIf, context), mode !== 'off');
    assert.equal(evaluate(jobIf, {...context, github: {...context.github, ref: 'refs/heads/candidate'}}), false);
    assert.equal(evaluate(condition(diagnostic), context), false);
    assert.equal(evaluate(condition(step('Run once')), context), true);
    assert.equal(evaluate(condition(step('Submit the signed')), context), mode === 'publish');
    const failedDelivery = {...context, failed: true, steps: {...context.steps, delivery: {outcome: 'failure', outputs: {}}}};
    assert.equal(evaluate(condition(diagnostic), failedDelivery), true);
    // A successful diagnostic does not restore the implicit success() gate.
    assert.equal(evaluate(condition(step('Submit the signed')), {...failedDelivery,
      steps: {...failedDelivery.steps, diagnostic: {outcome: 'success'}}}), false);
    assert.equal(evaluate(condition(step('Independently verify')), failedDelivery), false);
    for (const outcome of ['skipped', 'success', 'cancelled']) {
      assert.equal(evaluate(condition(diagnostic), {...failedDelivery, steps: {...failedDelivery.steps,
        delivery: {outcome, outputs: {}}, limited: {outcome: 'failure', outputs: {}}}}), false);
    }
  }
  assert.equal(condition(step('Explain outcome')), 'always()');
  const tokenSteps = stepBlocks.filter(item => item.body.includes('secrets.FEE_CLOUD_GITHUB_TOKEN'));
  assert.equal(tokenSteps.length, 1); assert.equal(tokenSteps[0].name, step('Submit the signed').name);
  const diagnosticSource = fs.readFileSync(new URL('./diagnose.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(diagnosticSource, /from ['"].*(?:report|delivery|ib_mcp|publish).*['"]/);
});
