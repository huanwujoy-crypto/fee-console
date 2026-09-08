import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSourcePlan, validatePlannedCall, validateSourcePlan, runSourcePlanCli } from './xuan-ib-source-plan.mjs';
import { SOURCE_HOOK_TOOLS } from './xuan-ib-source-hook.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const context = edition => ({ protocol: 'full-live', edition });
const plan = () => buildSourcePlan(context('am'));
const calls = value => value.batches.flatMap(batch => batch.calls);
const ssCall = () => clone(plan().batches[2].calls[0]);
const cliPath = fileURLToPath(new URL('./xuan-ib-source-plan.mjs', import.meta.url));

for (const edition of ['am', 'pm']) {
  test(`${edition} produces deterministic 5+9 intent with explicit unverified status`, () => {
    const value = buildSourcePlan(context(edition));
    assert.deepEqual(value, buildSourcePlan(context(edition), clone(registry)));
    assert.deepEqual(validateSourcePlan(value), value);
    assert.equal(value.status, 'planned-not-authorized');
    assert.equal(value.runtimeEvidence, 'not-checked');
    assert.equal(value.protocol, 'full-live');
    assert.equal(value.edition, edition);
    assert.match(value.registryFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(value.batches.map(batch => batch.calls.length), [2, 3, 3, 3, 1, 2]);
    assert.equal(new Set(calls(value).map(call => call.sourceKey)).size, 14);
    assert.deepEqual(value.batches[1].after, ['ib-1', 'account-scope-confirmed']);
    assert.deepEqual(value.batches[0].after, value.batches[2].after);
    assert.match(value.batches[0].after[0], /fresh-edition-run-bound-association/);
    assert.deepEqual(value.batches.slice(3).map(batch => batch.after), [
      ['sharesight-family-1'], ['sharesight-family-2'], ['sharesight-family-3'],
    ]);
    assert.deepEqual(calls(value).filter(call => call.sourceKey.startsWith('sharesight.')).map(call => call.toolInput.portfolio),
      registry.portfolios.filter(item => item.requiredEachReport).map(item => String(item.portfolioId)));
    for (const call of calls(value)) {
      assert.deepEqual(validatePlannedCall(call), call);
      if (call.sourceKey.startsWith('sharesight.')) {
        assert.equal(call.toolName, SOURCE_HOOK_TOOLS.sharesight);
        assert.deepEqual(Object.keys(call.toolInput), ['portfolio']);
        assert.match(call.toolInput.portfolio, /^\d+$/);
      }
    }
    assert.deepEqual(calls(value).find(call => call.sourceKey === 'ib.trades').toolInput, { period: 'TODAY' });
    assert.ok(!JSON.stringify(value).includes('portfolioName'));
    assert.doesNotMatch(JSON.stringify(value), /"(?:accountId|account_id|token|raw|amount|holdings|receipt|journalPath)"|\bU\d{6,}\b/);
  });
}

test('building and validating perform no IO or execution after module initialization', t => {
  for (const method of ['readFileSync', 'writeFileSync', 'openSync', 'appendFileSync', 'mkdirSync']) {
    t.mock.method(fs, method, () => { throw new Error(`unexpected IO: ${method}`); });
  }
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  assert.deepEqual(validateSourcePlan(buildSourcePlan(context('am'))), buildSourcePlan(context('am')));
});

test('calls and plans are independent snapshots and do not mutate their inputs', () => {
  const input = clone(registry), before = JSON.stringify(input);
  const first = buildSourcePlan(context('am'), input), second = validateSourcePlan(first, input);
  second.batches[0].calls[0].toolName = 'CHANGED';
  assert.notEqual(first.batches[0].calls[0].toolName, 'CHANGED');
  const single = first.batches[2].calls[0], checked = validatePlannedCall(single);
  checked.toolInput.portfolio = 'CHANGED';
  assert.notEqual(single.toolInput.portfolio, 'CHANGED');
  assert.equal(JSON.stringify(input), before);
});

for (const bad of [undefined, null, {}, { protocol: 'full-live' }, { edition: 'am' },
  { protocol: 'weekly', edition: 'am' }, { protocol: 'assemble-weekly', edition: 'pm' },
  { protocol: 'minimal', edition: 'pm' }, { protocol: 'FULL-LIVE', edition: 'am' },
  { protocol: 'full-live', edition: 'adhoc' }, { protocol: 'full-live', edition: 'AM' },
  { protocol: 'full-live', edition: 'am', authorize: true }]) {
  test(`reject invalid or legacy context ${JSON.stringify(bad)}`, () => {
    assert.throws(() => buildSourcePlan(bad), /XUAN-IB source plan:/);
  });
}

test('reject a changed registry even when the overall scope counts still validate', () => {
  const changed = clone(registry);
  changed.portfolios[0].portfolioId = 99999999;
  assert.throws(() => buildSourcePlan(context('am'), changed), /INVALID_OR_CHANGED_REGISTRY/);
  changed.portfolios[0].portfolioId = registry.portfolios[0].portfolioId;
  changed.portfolios[0].portfolioName = 'Changed name';
  assert.throws(() => validateSourcePlan(plan(), changed), /INVALID_OR_CHANGED_REGISTRY/);
});

test('all required registry sources are planned; unknown required roles cannot be silently omitted', () => {
  const value = plan();
  const required = registry.portfolios.filter(item => item.requiredEachReport);
  assert.equal(required.length, 9);
  assert.equal(required.filter(item => item.role === 'family').length, 7);
  assert.equal(required.filter(item => item.role === 'ai_only').length, 2);
  assert.equal(calls(value).length, 14);
  assert.deepEqual(new Set(calls(value).filter(call => call.sourceKey.startsWith('sharesight.'))
    .map(call => call.sourceKey)), new Set(required.map(item => `sharesight.${item.portfolioId}`)));
  const changed = clone(registry);
  changed.portfolios.find(item => item.requiredEachReport).role = 'unknown-required-role';
  assert.throws(() => buildSourcePlan(context('am'), changed), /INVALID_OR_CHANGED_REGISTRY/);
});

for (const [name, toolName] of [['undefined', undefined], ['null', null], ['empty', ''],
  ['whitespace', '   '], ['number', 1], ['object', {}]]) {
  test(`tool name must be a nonempty string: ${name}`, () => {
    const call = ssCall(); call.toolName = toolName;
    assert.throws(() => validatePlannedCall(call), /UNEXPECTED_SOURCE_TOOL/);
  });
}

for (const [name, mutate] of [
  ['holdings API', call => { call.toolName = call.toolName.replace('get_performance', 'get_holdings'); }],
  ['unrelated tool', call => { call.toolName = 'write_financial_record'; }],
  ['portfolio name', call => { call.toolInput.portfolio = registry.portfolios[0].portfolioName; }],
  ['numeric rather than string ID', call => { call.toolInput.portfolio = Number(call.toolInput.portfolio); }],
  ['other portfolio ID', call => { call.toolInput.portfolio = '99999999'; }],
  ['missing portfolio argument', call => { call.toolInput = {}; }],
  ['extra argument accepted by generic hook', call => { call.toolInput.include_sales = false; }],
  ['extra null argument', call => { call.toolInput.start_date = null; }],
  ['response substituted for input', call => { call.toolInput = { result: {} }; }],
  ['extra call field', call => { call.authorized = true; }],
  ['missing tool name', call => { delete call.toolName; }],
  ['excluded source', call => { call.sourceKey = `sharesight.${registry.portfolios.find(item => item.role === 'excluded').portfolioId}`; }],
  ['unknown IB endpoint', call => { call.sourceKey = 'ib.cancelOrder'; }],
]) {
  test(`reject planned call: ${name}`, () => {
    const call = ssCall(); mutate(call);
    assert.throws(() => validatePlannedCall(call), /XUAN-IB source plan:/);
  });
}

test('trades are explicitly TODAY; other IB calls have no optional/extra arguments', () => {
  for (const replacement of [{}, { period: 'LAST_WEEK' }, { period: 'TODAY', extra: null }]) {
    const call = clone(calls(plan()).find(item => item.sourceKey === 'ib.trades'));
    call.toolInput = replacement;
    assert.throws(() => validatePlannedCall(call), /XUAN-IB source plan:/);
  }
  const call = clone(plan().batches[0].calls[0]); call.toolInput = { account_id: 'SYNTHETIC' };
  assert.throws(() => validatePlannedCall(call), /INVALID_PLANNED_INPUT_FIELDS/);
});

for (const [name, mutate] of [
  ['missing source', value => { value.batches[0].calls.pop(); }],
  ['duplicate source', value => { value.batches[1].calls[0] = clone(value.batches[0].calls[0]); }],
  ['missing batch', value => { value.batches.pop(); }],
  ['extra batch', value => { value.batches.push(clone(value.batches[0])); }],
  ['batch order changed', value => { [value.batches[0], value.batches[1]] = [value.batches[1], value.batches[0]]; }],
  ['four concurrent Sharesight sources', value => { value.batches[2].calls.push(value.batches[3].calls.pop()); }],
  ['removed association precondition', value => { value.batches[0].after = []; }],
  ['removed account scope precondition', value => { value.batches[1].after = ['ib-1']; }],
  ['auxiliary concurrent with family', value => { value.batches[5].after = []; }],
  ['false successful status', value => { value.status = 'verified'; }],
  ['claimed runtime proof', value => { value.runtimeEvidence = 'verified'; }],
  ['wrong registry fingerprint', value => { value.registryFingerprint = 'a'.repeat(64); }],
  ['schema changed', value => { value.schemaVersion = 2; }],
  ['kind changed', value => { value.kind = 'authorized-run'; }],
  ['weekly protocol', value => { value.protocol = 'weekly'; }],
  ['adhoc edition', value => { value.edition = 'adhoc'; }],
  ['extra authority field', value => { value.authorization = 'SYNTHETIC'; }],
]) {
  test(`reject altered whole plan: ${name}`, () => {
    const value = plan(); mutate(value);
    assert.throws(() => validateSourcePlan(value), /XUAN-IB source plan:/);
  });
}

test('CLI only accepts explicit full-live AM/PM planning arguments', () => {
  assert.deepEqual(runSourcePlanCli(['--protocol', 'full-live', '--edition', 'pm']), buildSourcePlan(context('pm')));
  for (const args of [[], ['am'], ['--edition', 'am', '--protocol', 'full-live'],
    ['--protocol', 'full-live', '--edition', 'am', '--output', 'SYNTHETIC_PRIVATE_PATH']]) {
    assert.throws(() => runSourcePlanCli(args), /USAGE_PROTOCOL_FULL_LIVE_EDITION_AM_OR_PM/);
  }
  const good = spawnSync(process.execPath, [cliPath, '--protocol', 'full-live', '--edition', 'am'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stderr, '');
  assert.deepEqual(validateSourcePlan(JSON.parse(good.stdout)), plan());
  const bad = spawnSync(process.execPath, [cliPath, '--protocol', 'SYNTHETIC_PRIVATE_ARGUMENT', '--edition', 'am'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.deepEqual(JSON.parse(bad.stderr), { status: 'failed', code: 'FULL_LIVE_PROTOCOL_REQUIRED' });
  assert.ok(!bad.stderr.includes('SYNTHETIC_PRIVATE_ARGUMENT'));
});
