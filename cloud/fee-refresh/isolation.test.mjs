import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSyntheticRefreshAcceptance, diagnoseRefreshBrowserProbe, RUNTIME_FILES } from './isolation.mjs';
import { approvalRegistry, classifyChanges } from '../../scripts/approval-tier-plan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const BASE = 'node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';
const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [path.join(here, 'isolation.mjs'), ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...extraEnv },
});

test('container uses the recorded pinned base, runs non-root and starts disabled without package installation', () => {
  const docker = fs.readFileSync(path.join(here, 'Dockerfile'), 'utf8');
  // The verified official digest is recorded in the recipe itself: no build
  // argument can substitute another base and no build-time command runs.
  assert.deepEqual([...docker.matchAll(/^FROM\s+(\S+)$/gm)].map(m => m[1]), [BASE]);
  assert.doesNotMatch(docker, /^\s*(ARG|RUN|ADD)\s/m);
  assert.match(docker, /^USER 10001:10001$/m); assert.match(docker, /FEE_REFRESH_MODE=disabled/);
  assert.match(docker, /^CMD \["serve"\]$/m);
  assert.doesNotMatch(docker, /apt-get|npm |pip |curl |wget |secret|data\.json/);
  const copies = docker.split('\n').filter(line => line.startsWith('COPY '));
  assert.deepEqual(copies, ['COPY ' + RUNTIME_FILES.join(' ') + ' /app/scripts/']);
});

test('Dockerfile-specific context permits only its recipe and the exact runtime closure', () => {
  const lines = fs.readFileSync(path.join(here, 'Dockerfile.dockerignore'), 'utf8').trim().split('\n');
  assert.equal(lines[0], '**');
  const files = lines.slice(1).filter(line => !line.endsWith('/')).map(line => line.slice(1)).sort();
  assert.deepEqual(files, [...RUNTIME_FILES, 'cloud/fee-refresh/Dockerfile', 'cloud/fee-refresh/Dockerfile.dockerignore'].sort());
  assert.ok(!files.some(file => /daily\.mjs|\.json$|\.git|claude\/|ratio-/.test(file)));
});

test('copied minimal runtime imports completely and disabled job performs no transport or credential reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-runtime-closure-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts/fee-manager-refresh-entry.mjs'), 'job'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', FEE_REFRESH_MODE: 'disabled' },
    });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), { mode: 'disabled', handled: 0 });
    assert.equal(r.stderr, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone synthetic acceptance exercises role limits, duplicate/close races and final refusal with no fetch', async () => {
  const original = globalThis.fetch; let reads = 0;
  globalThis.fetch = async () => { reads++; throw Error('unexpected external transport'); };
  try {
    const r = await runSyntheticRefreshAcceptance();
    assert.equal(r.status, 'PASS_SYNTHETIC_ONLY'); assert.equal(r.producerDispatches, 0); assert.equal(r.ratioCollections, 0);
    assert.equal(r.productionReady, false); assert.equal(r.liveAcceptanceComplete, false); assert.equal(reads, 0);
    for (const code of ['fee:ACCEPTANCE_REFUSED', 'fee+ratio:RATIO_NOT_PUBLISHED', 'CLOSE_ATOMIC', 'LATE_POST_REFUSED',
      'STALE_NOT_QUEUED', 'UNAVAILABLE_NOT_SUCCESS', 'ZERO_PRODUCTION_OR_RATIO_COLLECTION']) assert.ok(r.checks.includes(code), code);
    assert.doesNotMatch(JSON.stringify(r), /access_token|synthetic-offline-only|requestId|dataSha256/);
  } finally { globalThis.fetch = original; }
});

test('synthetic runner has no parameter for real transports, plans or launch mode', async () => {
  for (const options of [{ mode: 'launch' }, { http: () => { throw Error(); } }, { plan: {} }, undefined])
    await assert.rejects(runSyntheticRefreshAcceptance(options), /REFRESH_ISOLATION_REFUSED/);
});

test('CLI emits synthetic evidence only; inherited launch configuration cannot activate it', () => {
  const r = cli(['--synthetic'], { FEE_REFRESH_MODE: 'launch', FEE_REFRESH_GIST_ID: 'real-input-not-consumed' });
  assert.equal(r.status, 0, r.stderr); const output = JSON.parse(r.stdout);
  assert.equal(output.status, 'PASS_SYNTHETIC_ONLY'); assert.equal(output.productionReady, false); assert.equal(output.producerDispatches, 0);
});

test('unsupported execution commands fail closed', () => {
  for (const args of [[], ['--deploy'], ['--launch'], ['--synthetic', '--launch'], ['--check-plan'], ['--check-plan', '/tmp/other']]) {
    const result = cli(args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'REFRESH_ISOLATION_REFUSED');
  }
});

test('new packaging and parser paths stay sensitive and CI includes both workstreams', () => {
  for (const file of ['cloud/fee-refresh/Dockerfile', 'cloud/fee-refresh/Dockerfile.dockerignore',
    'cloud/fee-refresh/deployment-plan.json', 'cloud/fee-refresh/isolation.mjs', 'cloud/fee-refresh/isolation.test.mjs',
    'cloud/fee-refresh/verify-readonly.sh', 'scripts/fee-manager-refresh-acceptance.mjs', 'scripts/fee-manager-refresh-acceptance.test.mjs',
    'scripts/fee-manager-refresh-mode.test.mjs', 'scripts/fee-manager-refresh-deploy.test.mjs',
    'scripts/fee-ratio-xlsx.py', 'scripts/fee-ratio-xlsx.test.py']) {
    assert.ok(approvalRegistry.sensitiveFiles.includes(file), file);
    assert.equal(classifyChanges([{ path: file, status: 'M', baseMode: '100644', headMode: '100644' }]), 'specific');
  }
  assert.equal(approvalRegistry.ordinaryFiles.length, 22);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/scripts-check.yml'), 'utf8');
  assert.match(workflow, /node --test cloud\/fee-refresh\/\*\.test\.mjs/);
  assert.match(workflow, /node cloud\/fee-refresh\/isolation\.mjs --synthetic/);
  assert.match(workflow, /scripts\/fee-ratio-source-collector\.test\.mjs/);
  assert.doesNotMatch(workflow, /docker (?:build|push)|gcloud run deploy|isolation\.mjs --launch/);
});

const probeRecord = (extra = {}) => ({ status: 0, signal: null, errorCode: 'ETIMEDOUT', stdout: null,
  stderr: null, stdoutComplete: false, stderrComplete: false, versionAvailable: true, ...extra });
test('browser diagnostic gives a timeout priority over exit zero and keeps missing page/log evidence unknown', () => {
  const r = diagnoseRefreshBrowserProbe(probeRecord());
  assert.equal(r.outcome, 'TIMED_OUT'); assert.equal(r.versionCheckConfirmed, true);
  assert.equal(r.probeScript, 'UNCONFIRMED'); assert.equal(r.logsComplete, false);
  assert.equal(r.accessRestriction, 'NOT_OBSERVED_IN_AVAILABLE_LOGS'); assert.equal(r.automaticRetryAllowed, false);
  assert.equal(r.managerUiAccepted, false); assert.equal(r.liveAcceptanceComplete, false);
});

test('DBus error tail is an observation, not proof of browser unavailability or access denial', () => {
  const stderr = '[synthetic:ERROR:dbus/bus.cc] Failed to connect to the bus: Unknown address type\norg.freedesktop.DBus.NameHasOwner';
  const r = diagnoseRefreshBrowserProbe(probeRecord({ stdout: '', stdoutComplete: true, stderr }));
  assert.equal(r.outcome, 'TIMED_OUT'); assert.equal(r.dbusErrorsObserved, true);
  assert.equal(r.accessRestriction, 'NOT_OBSERVED_IN_AVAILABLE_LOGS'); assert.equal(r.logsComplete, false);
});

test('browser diagnostic distinguishes executable/launch failures and policy mentions without prescribing a retry', () => {
  for (const [errorCode, outcome] of [['ENOENT', 'EXECUTABLE_NOT_FOUND'], ['EACCES', 'SPAWN_ACCESS_DENIED'], ['EPERM', 'SPAWN_ACCESS_DENIED']]) {
    const r = diagnoseRefreshBrowserProbe(probeRecord({ status: null, errorCode, versionAvailable: null }));
    assert.equal(r.outcome, outcome); assert.equal(r.automaticRetryAllowed, false);
  }
  const policy = diagnoseRefreshBrowserProbe(probeRecord({ errorCode: null, status: 1, stderr: 'net::ERR_BLOCKED_BY_ADMINISTRATOR' }));
  assert.equal(policy.accessRestriction, 'PAGE_POLICY_ERROR_MENTIONED'); assert.equal(policy.managerUiAccepted, false);
});

test('a probe marker proves only its script, and never overrides timeout or approves the manager UI', () => {
  const output = { stdout: '<pre id="result">ok</pre>', stdoutComplete: true, stderr: '', stderrComplete: true };
  assert.equal(diagnoseRefreshBrowserProbe(probeRecord(output)).outcome, 'TIMED_OUT');
  const completed = diagnoseRefreshBrowserProbe(probeRecord({ ...output, errorCode: null }));
  assert.equal(completed.outcome, 'PROBE_SCRIPT_COMPLETED'); assert.equal(completed.managerUiAccepted, false);
  assert.equal(completed.productionReady, false);
  assert.equal(diagnoseRefreshBrowserProbe(probeRecord({ ...output, stdout: '', errorCode: null })).outcome, 'PAGE_UNCONFIRMED');
});

test('browser diagnostic refuses malformed or oversized records and does not echo raw log contents', () => {
  for (const extra of [{ extra: true }, { status: '0' }, { stdoutComplete: true }, { stderr: 'x'.repeat(65537) }, { versionAvailable: 'true' }])
    assert.throws(() => diagnoseRefreshBrowserProbe(probeRecord(extra)), /REFRESH_ISOLATION_REFUSED/);
  const r = diagnoseRefreshBrowserProbe(probeRecord({ stderr: 'synthetic private content must not be echoed' }));
  assert.ok(!JSON.stringify(r).includes('private content'));
});

test('browser diagnostic CLI reads bounded stdin only and never launches a browser or enables production', () => {
  const run = input => spawnSync(process.execPath, [path.join(here, 'isolation.mjs'), '--diagnose-browser'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000, input,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', FEE_REFRESH_MODE: 'launch' },
  });
  const r = run(JSON.stringify(probeRecord())); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'TIMED_OUT'); assert.equal(JSON.parse(r.stdout).automaticRetryAllowed, false);
  for (const input of ['', 'x'.repeat(262145), '{"status":0,"status":1}']) {
    const failed = run(input); assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.trim(), 'REFRESH_ISOLATION_REFUSED');
  }
});
