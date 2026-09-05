import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareMinimalRun, runMinimalPrepareCli } from './xuan-ib-minimal-prepare.mjs';
import { writeCaptureJson, readCaptureJson } from './xuan-ib-source-capture.mjs';
import { initRunJournal, startJournalStage, finishJournalStage, showRunJournal, RUN_STAGES } from './xuan-ib-run-clock.mjs';
import { fingerprint, IB_ENDPOINTS } from './xuan-ib-run-manifest.mjs';
import { associationPolicyBlob, createPreReadAssociationReceipt, extractAssociationReceipt } from './xuan-ib-account-association.mjs';
import { runPrepareCli } from './xuan-ib-report-prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousHtml = fs.readFileSync(path.join(root, 'xuan-ib/latest.html'), 'utf8');
const previousMeta = JSON.parse(fs.readFileSync(path.join(root, 'xuan-ib/latest.meta.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(root, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
const priorTemplate = previousHtml.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">[\s\S]*?<\/template>/)[0];

async function fixture(t, { missingAssociation = false, failedRead = false, activeRead = false, mutate = null } = {}) {
  // Synthetic times stay in this process's real monotonic domain so the
  // wrapper can append genuine local stage times without a clock workaround.
  const epoch = Date.now() - 10_000;
  const monotonic = Number(process.hrtime.bigint() / 1_000_000n) - 10_000;
  const stamp = offset => new Date(epoch + offset).toISOString();
  const clock = offset => ({ wallNow: () => epoch + offset, monotonicNowMs: () => monotonic + offset });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-minimal-prepare-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journalPath = path.join(dir, 'run.jsonl');
  initRunJournal(journalPath, clock(0));
  startJournalStage(journalPath, 'bootstrap', clock(100));
  finishJournalStage(journalPath, 'bootstrap', {}, clock(200));
  const policy = { schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
    basis: 'owner-attested-recurring-v1', status: 'active', purpose: 'xuan-ib-read-only-report',
    editions: ['adhoc'], publisher: 'claude-verified-candidate-v1', validFrom: stamp(-1000),
    expiresAt: stamp(7 * 86_400_000 - 1000) };
  const snapshot = (checkedAt = new Date().toISOString(), selected = policy) => ({
    policy: selected, policyCommit: 'a'.repeat(40), policyBlob: associationPolicyBlob(selected), checkedAt,
  });
  const association = await createPreReadAssociationReceipt(snapshot(stamp(400)), {
    journalPath, now: epoch + 400, edition: 'adhoc', previousSourceSha: previousMeta.sourceSha,
  });
  startJournalStage(journalPath, 'ib-read', clock(1000));
  finishJournalStage(journalPath, 'ib-read', failedRead ? { status: 'failed', errorCode: 'SYNTHETIC_FAILED' } : {}, clock(2000));
  startJournalStage(journalPath, 'sharesight-read', clock(2100));
  if (!activeRead) finishJournalStage(journalPath, 'sharesight-read', {}, clock(3000));
  const dataDate = new Date(epoch + 8 * 3_600_000).toISOString().slice(0, 10);
  const captured = (raw, start, end) => ({ raw, status: 'ok', startedAt: stamp(start),
    completedAt: stamp(end), retries: 0, rawFingerprint: fingerprint(raw) });
  const raw = {
    accountSummary: { currency: 'USD', net_liquidation: 140, total_cash_value: 30 },
    balances: { balances: [{ currency: 'BASE', cash_balance: 30, settled_cash: 30,
      net_liquidation_value: 140, stock_market_value: 100, unrealized_pnl: 4, realized_pnl: 0, exchange_rate: 1 }] },
    positions: { positions: [{ contract_description: 'SYNTHETIC @ native',
      position: 2, market_price: 50, market_value: 100, currency: 'USD' }] },
    orders: { orders: [] }, trades: { trades: [] },
  };
  const input = { edition: 'adhoc', dataDate, previousSourceSha: previousMeta.sourceSha,
    ib: Object.fromEntries(IB_ENDPOINTS.map((endpoint, i) => [endpoint, captured(raw[endpoint], 1100 + i * 100, 1150 + i * 100)])),
    sharesight: registry.portfolios.filter(item => item.requiredEachReport).map(item => captured({
      result: { mode: 'read_only', portfolio: { id: item.portfolioId, currency_code: 'USD' },
        data: { report: { portfolio_id: item.portfolioId, value: 999, end_date: '2026-08-24',
          currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } },
    }, 2200, 2300)),
  };
  if (mutate) mutate(input, association);
  writeCaptureJson(dir, 'input.json', input);
  if (!missingAssociation) writeCaptureJson(dir, 'association.json', association);
  const baseline = { previousHtml, previousMeta, registry };
  const calls = [];
  const options = {
    journalPath,
    loadPolicy: args => { calls.push(['policy', args]); return snapshot(); },
    readBaseline: value => { calls.push(['baseline', value]); return baseline; },
    prepareCandidate: args => { calls.push(['candidate', args]); return { status: 'SYNTHETIC_STUB_ONLY' }; },
  };
  return { dir, journalPath, input, association, snapshot, policy, options, calls, baseline };
}
const stages = f => showRunJournal(f.journalPath).stages;
const outputs = f => ['view.json', 'sources.json', 'candidate.html'].filter(file => fs.existsSync(path.join(f.dir, file)));
function expectNoRetry(f, firstPattern, options = f.options) {
  assert.throws(() => prepareMinimalRun(f.dir, options), firstPattern);
  const failedBytes = fs.readFileSync(f.journalPath, 'utf8');
  assert.throws(() => prepareMinimalRun(f.dir, options), /EXACT_COMPLETED_READ_STAGES_REQUIRED|OUTPUT_ALREADY_EXISTS/);
  assert.equal(fs.readFileSync(f.journalPath, 'utf8'), failedBytes, 'failure must not reopen a journal stage');
}

test('one command derives private fixed outputs then hands the exact journal and filenames to existing prepare', async t => {
  const f = await fixture(t), originalInput = fs.readFileSync(path.join(f.dir, 'input.json'), 'utf8');
  const originalAssociation = fs.readFileSync(path.join(f.dir, 'association.json'), 'utf8');
  const result = prepareMinimalRun(f.dir, f.options);
  assert.deepEqual(result, { status: 'SYNTHETIC_STUB_ONLY' });
  assert.deepEqual(f.calls.map(item => item[0]), ['policy', 'baseline', 'candidate']);
  assert.deepEqual(f.calls[0][1], { cwd: root, requireActive: true });
  assert.deepEqual(f.calls[2][1], [path.join(f.dir, 'view.json'), path.join(f.dir, 'sources.json'),
    path.join(f.dir, 'candidate.html'), '--journal', f.journalPath]);
  assert.deepEqual(stages(f).map(item => [item.name, item.status]), RUN_STAGES.slice(0, 6).map(name => [name, 'ok']));
  assert.deepEqual(outputs(f), ['view.json', 'sources.json']);
  for (const file of outputs(f)) assert.equal(fs.statSync(path.join(f.dir, file)).mode & 0o777, 0o600);
  const view = readCaptureJson(path.join(f.dir, 'view.json')), evidence = readCaptureJson(path.join(f.dir, 'sources.json'));
  assert.equal(view.kpis[2].value, 100); assert.equal(evidence.sources.sharesight.length, 9);
  assert.deepEqual(evidence.sources.ib.accountAssociation, f.association);
  assert.equal(fs.readFileSync(path.join(f.dir, 'input.json'), 'utf8'), originalInput);
  assert.equal(fs.readFileSync(path.join(f.dir, 'association.json'), 'utf8'), originalAssociation);
});

test('actual recurring build -> existing prepare CLI -> real trusted guard -> private candidate completes all nine stages', async t => {
  const f = await fixture(t);
  let secondPolicyCheck = 0;
  const result = prepareMinimalRun(f.dir, { ...f.options,
    prepareCandidate: args => runPrepareCli(args, { loadAssociationPolicy: args => {
      secondPolicyCheck++; assert.deepEqual(args, { cwd: root, requireActive: false }); return f.snapshot();
    } }),
  });
  assert.equal(result.status, 'prepared-not-published');
  assert.equal(secondPolicyCheck, 1, 'existing prepare must independently obtain current policy again');
  const journal = showRunJournal(f.journalPath);
  assert.equal(journal.timing.allRequiredStagesFinished, true);
  assert.ok(journal.stages.every(stage => stage.status === 'ok'));
  assert.equal(journal.sourceBinding, null, 'no commit or publication is manufactured');
  assert.deepEqual(outputs(f), ['view.json', 'sources.json', 'candidate.html']);
  const html = fs.readFileSync(path.join(f.dir, 'candidate.html'), 'utf8');
  assert.equal(fs.statSync(path.join(f.dir, 'candidate.html')).mode & 0o777, 0o600);
  assert.deepEqual(extractAssociationReceipt(html), f.association);
  assert.ok(html.includes(priorTemplate));
  const abc = previousHtml.match(/<template id="xuan-etf-open-summary-v3" type="application\/json">[\s\S]*?<\/template>/)?.[0];
  if (abc) assert.ok(html.includes(abc));
  assert.ok(!html.includes(f.journalPath));
  assert.ok(!html.includes(f.input.ib.positions.rawFingerprint));
});

test('missing pre-read association stops before starting any derivation or requesting a policy', async t => {
  const f = await fixture(t, { missingAssociation: true }), before = fs.readFileSync(f.journalPath, 'utf8');
  assert.throws(() => prepareMinimalRun(f.dir, f.options), /PRIVATE_PATH_UNAVAILABLE/);
  assert.equal(fs.readFileSync(f.journalPath, 'utf8'), before);
  assert.deepEqual(outputs(f), []); assert.deepEqual(f.calls, []);
});

test('a failed or still-active financial stage cannot be reclassified as successful', async t => {
  for (const change of [{ failedRead: true }, { activeRead: true }]) {
    const f = await fixture(t, change), before = fs.readFileSync(f.journalPath, 'utf8');
    assert.throws(() => prepareMinimalRun(f.dir, f.options), /EXACT_COMPLETED_READ_STAGES_REQUIRED/);
    assert.equal(fs.readFileSync(f.journalPath, 'utf8'), before);
    assert.deepEqual(outputs(f), []); assert.deepEqual(f.calls, []);
  }
});

test('an existing output is never overwritten or treated as permission to repeat the run', async t => {
  for (const name of ['view.json', 'sources.json', 'candidate.html']) {
    const f = await fixture(t), file = path.join(f.dir, name);
    fs.writeFileSync(file, 'SYNTHETIC EXISTING', { flag: 'wx', mode: 0o600 });
    const before = fs.readFileSync(f.journalPath, 'utf8');
    assert.throws(() => prepareMinimalRun(f.dir, f.options), /OUTPUT_ALREADY_EXISTS/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'SYNTHETIC EXISTING');
    assert.equal(fs.readFileSync(f.journalPath, 'utf8'), before); assert.deepEqual(f.calls, []);
  }
});

test('expired or revoked policy fails validate permanently before any view is written', async t => {
  for (const status of ['expired', 'revoked']) {
    const f = await fixture(t);
    const policy = status === 'expired' ? { ...f.policy, expiresAt: new Date(Date.now() - 1).toISOString() }
      : { ...f.policy, status: 'revoked' };
    const options = { ...f.options, loadPolicy: () => f.snapshot(new Date().toISOString(), policy) };
    expectNoRetry(f, /expired|revoked/, options);
    assert.equal(stages(f).at(-1).name, 'validate'); assert.equal(stages(f).at(-1).status, 'failed');
    assert.deepEqual(outputs(f), []);
  }
});

test('missing any of the fourteen required sources fails validate rather than supplying old or empty data', async t => {
  for (const omitted of ['ib.orders', 'sharesight']) {
    const f = await fixture(t, { mutate: input => {
      if (omitted === 'ib.orders') delete input.ib.orders; else input.sharesight.pop();
    } });
    expectNoRetry(f);
    assert.equal(stages(f).at(-1).name, 'validate'); assert.equal(stages(f).at(-1).status, 'failed');
    assert.deepEqual(outputs(f), []);
  }
});

test('unknown nonempty order shape fails derive and cannot be retried by restarting the journal', async t => {
  const f = await fixture(t, { mutate: input => {
    input.ib.orders.raw.orders = [{ unknown_synthetic_field: true }];
    input.ib.orders.rawFingerprint = fingerprint(input.ib.orders.raw);
  } });
  expectNoRetry(f, /UNSUPPORTED_ORDER_SHAPE/);
  assert.equal(stages(f).find(stage => stage.name === 'validate').status, 'ok');
  assert.equal(stages(f).at(-1).name, 'derive'); assert.equal(stages(f).at(-1).status, 'failed');
  assert.deepEqual(outputs(f), []);
});

test('source tampering and cross-run receipt are rejected in validation without creating public material', async t => {
  for (const mutate of [input => { input.ib.positions.raw.positions[0].market_value++; },
    (_input, association) => { association.runId = 'f'.repeat(64); }]) {
    const f = await fixture(t, { mutate }); expectNoRetry(f);
    assert.equal(stages(f).at(-1).name, 'validate'); assert.equal(stages(f).at(-1).status, 'failed');
    assert.deepEqual(outputs(f), []);
  }
});

test('untrusted checkout baseline failure burns validation instead of accepting a substitute history', async t => {
  const f = await fixture(t);
  expectNoRetry(f, /CHECKOUT_BASELINE_NOT_CURRENT_MAIN/, { ...f.options,
    readBaseline: () => { throw new Error('Minimal prepare: CHECKOUT_BASELINE_NOT_CURRENT_MAIN'); },
  });
  assert.equal(stages(f).at(-1).status, 'failed'); assert.deepEqual(outputs(f), []);
});

test('a downstream prepare failure keeps immutable inputs and outputs for inspection, never restarts the run', async t => {
  const f = await fixture(t);
  expectNoRetry(f, /SYNTHETIC_PREPARE_FAILED/, { ...f.options, prepareCandidate: () => {
    startJournalStage(f.journalPath, 'render');
    finishJournalStage(f.journalPath, 'render', { status: 'failed', errorCode: 'SYNTHETIC_PREPARE_FAILED' });
    throw new Error('SYNTHETIC_PREPARE_FAILED');
  } });
  assert.deepEqual(outputs(f), ['view.json', 'sources.json']);
  assert.equal(stages(f).at(-1).name, 'render'); assert.equal(stages(f).at(-1).status, 'failed');
});

test('operational CLI accepts no policy, clock, baseline or source bypass flags and redacts errors', async t => {
  for (const args of [[], ['dir', '--policy', 'file'], ['dir', '--journal', 'file', '--now', '1'],
    ['dir', '--journal', 'file', '--association-snapshot', 'file']]) {
    assert.throws(() => runMinimalPrepareCli(args), /USAGE_PRIVATE_DIR_JOURNAL/);
  }
  const f = await fixture(t, { missingAssociation: true });
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/xuan-ib-minimal-prepare.mjs'),
    f.dir, '--journal', f.journalPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { status: 'failed', code: 'PRIVATE_PATH_UNAVAILABLE' });
  assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes(f.dir));
});

test('an output created after the initial precheck still cannot be overwritten by narrative writing', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'view.json');
  expectNoRetry(f, /OUTPUT_ALREADY_EXISTS/, { ...f.options, readBaseline: () => {
    fs.writeFileSync(file, 'SYNTHETIC CONCURRENT OUTPUT', { flag: 'wx', mode: 0o600 });
    return f.baseline;
  } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'SYNTHETIC CONCURRENT OUTPUT');
  assert.equal(stages(f).at(-1).name, 'narrative'); assert.equal(stages(f).at(-1).status, 'failed');
  assert.deepEqual(outputs(f), ['view.json']);
});

test('unsafe directory or journal permissions fail without opening a new stage', async t => {
  for (const change of ['directory', 'journal']) {
    const f = await fixture(t), before = fs.readFileSync(f.journalPath, 'utf8');
    if (change === 'directory') fs.chmodSync(f.dir, 0o755); else fs.chmodSync(f.journalPath, 0o644);
    assert.throws(() => prepareMinimalRun(f.dir, f.options), /DIRECTORY_MUST_BE_0700|FILE_MUST_BE_PRIVATE_REGULAR_0600/);
    assert.equal(fs.readFileSync(f.journalPath, 'utf8'), before);
    assert.deepEqual(outputs(f), []); assert.deepEqual(f.calls, []);
  }
});
