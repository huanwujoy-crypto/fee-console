import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { armHookSource, captureHookSource, assembleHookSources, validateHookInput, SOURCE_HOOK_TOOLS,
  HOOK_ARM_TTL_MS, MAX_HOOK_EVENT_BYTES, runSourceHookCli } from './xuan-ib-source-hook.mjs';
import { CAPTURE_SOURCE_KEYS, readCaptureJson, assembleSourceCaptures } from './xuan-ib-source-capture.mjs';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { sourceRecordFromRaw } from './xuan-ib-source-adapter.mjs';
import { fingerprint } from './xuan-ib-run-manifest.mjs';

const cliPath = fileURLToPath(new URL('./xuan-ib-source-hook.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const bytes = value => Buffer.from(JSON.stringify(value));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const toolFor = key => SOURCE_HOOK_TOOLS[key.startsWith('sharesight.') ? 'sharesight' : key];
const inputFor = key => key.startsWith('sharesight.') ? { portfolio: key.slice('sharesight.'.length) }
  : key === 'ib.trades' ? { period: 'TODAY' } : {};
const rawFor = key => key === 'ib.accountSummary' ? { currency: 'USD', net_liquidation: 100, total_cash_value: 20 }
  : key.startsWith('ib.') ? { [key.slice(3)]: [] }
    : { result: { mode: 'read_only', portfolio: { id: Number(key.slice('sharesight.'.length)), currency_code: 'USD' },
      data: { report: { portfolio_id: Number(key.slice('sharesight.'.length)), value: 1, end_date: '2026-09-04',
        currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } } };
function fixture(t) {
  const base = Date.now() - 1000;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-source-hook-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'captures'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  const clock = n => ({ wallNow: () => base + n, monotonicNowMs: () => n });
  const options = n => ({ journalPath, wallNow: () => base + n });
  initRunJournal(journalPath, clock(0)); startJournalStage(journalPath, 'bootstrap', clock(1));
  finishJournalStage(journalPath, 'bootstrap', {}, clock(2));
  startJournalStage(journalPath, 'ib-read', clock(3)); startJournalStage(journalPath, 'sharesight-read', clock(4));
  const binding = key => ({ toolName: toolFor(key), runtimeSessionId: 'SYNTHETIC-RUNTIME-SESSION', toolInput: inputFor(key) });
  const arm = (key = 'ib.positions', time = 10) => armHookSource(dir, key, binding(key), options(time));
  const event = (key = 'ib.positions', overrides = {}) => ({
    hook_event_name: 'PostToolUse', session_id: 'SYNTHETIC-RUNTIME-SESSION', tool_use_id: `SYNTHETIC-${key}-USE`,
    tool_name: toolFor(key), tool_input: inputFor(key), tool_response: JSON.stringify(rawFor(key)),
    transcript_path: 'SYNTHETIC_PRIVATE_TRANSCRIPT', cwd: 'SYNTHETIC_PRIVATE_CWD', ...overrides,
  });
  const file = (key, suffix) => path.join(dir, `${key}.hook-${suffix}.json`);
  const capture = (armed, value = event(armed.sourceKey), time = 20) => captureHookSource(dir, armed.sourceKey, armed.nonce, bytes(value), options(time));
  return { base, root, dir, journalPath, clock, options, binding, arm, event, file, capture };
}
const noClaim = (f, key = 'ib.positions') => assert.equal(fs.existsSync(f.file(key, 'claim')), false);
const hasReceipt = (f, key = 'ib.positions') => fs.existsSync(path.join(f.dir, `${key}.receipt.json`));
const artifactBytes = f => Object.fromEntries(fs.readdirSync(f.dir).sort().map(name => [name, fs.readFileSync(path.join(f.dir, name), 'utf8')]));
const assemblyOptions = (f, offset = 11000) => ({ ...f.options(offset), previousSourceSha: sha,
  dataDate: new Date(f.base + 8 * 3_600_000).toISOString().slice(0, 10) });
const finishReads = (f, offset = 10000) => {
  finishJournalStage(f.journalPath, 'ib-read', {}, f.clock(offset));
  finishJournalStage(f.journalPath, 'sharesight-read', {}, f.clock(offset + 1));
};
function captureAll(f, { runtimeFor = () => 'SYNTHETIC-RUNTIME-SESSION', useIdFor = key => `SYNTHETIC-${key}-USE` } = {}) {
  for (const [i, key] of CAPTURE_SOURCE_KEYS.entries()) {
    const runtimeSessionId = runtimeFor(key);
    const armed = armHookSource(f.dir, key, { ...f.binding(key), runtimeSessionId }, f.options(10 + i * 10));
    f.capture(armed, f.event(key, { session_id: runtimeSessionId, tool_use_id: useIdFor(key) }), 11 + i * 10);
  }
}

test('arm precedes the actual capture and binds only exact tool/input/session metadata with a random five-minute nonce', t => {
  const f = fixture(t), original = fs.readFileSync(f.journalPath), armed = f.arm(), stored = readCaptureJson(armed.path);
  assert.equal(armed.status, 'armed-not-authorized'); assert.match(armed.nonce, /^[a-f0-9]{48}$/);
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.createdAt), HOOK_ARM_TTL_MS);
  assert.equal(HOOK_ARM_TTL_MS, 300000);
  assert.equal(stored.toolName, 'mcp__Interactive_Brokers__get_account_positions');
  assert.equal(stored.inputFingerprint, fingerprint({}));
  assert.equal(Object.hasOwn(stored, 'toolInput'), false);
  assert.equal(fs.statSync(armed.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(f.journalPath), original, 'arm must not append any journal stage');
  assert.throws(() => f.arm(), /EXISTING_HOOK_ARTIFACT/);
});

test('all fourteen synthetic sources capture original string transports and native raws then assemble adapter-compatible receipts', t => {
  const f = fixture(t); assert.equal(CAPTURE_SOURCE_KEYS.length, 14);
  const nonces = new Set();
  for (const [i, key] of CAPTURE_SOURCE_KEYS.entries()) {
    const armed = f.arm(key, 10 + i * 10), event = f.event(key), before = fs.readFileSync(f.journalPath);
    assert.equal(nonces.has(armed.nonce), false); nonces.add(armed.nonce);
    const result = f.capture(armed, event, 11 + i * 10);
    assert.equal(result.status, 'captured'); assert.equal(result.wrapper, 'json-string');
    assert.equal(result.transportFingerprint, fingerprint(event.tool_response));
    assert.equal(result.rawFingerprint, fingerprint(rawFor(key)));
    assert.notEqual(result.transportFingerprint, result.rawFingerprint);
    assert.deepEqual(readCaptureJson(f.file(key, 'raw')), rawFor(key));
    const transport = readCaptureJson(result.transportPath);
    assert.equal(transport.toolResponse, event.tool_response);
    assert.equal(transport.transportFingerprint, result.transportFingerprint);
    for (const forbidden of ['tool_input', 'transcript_path', 'cwd', 'error', 'toolInput']) assert.equal(Object.hasOwn(transport, forbidden), false);
    const receipt = readCaptureJson(result.receiptPath).receipt;
    assert.equal(sourceRecordFromRaw(rawFor(key), receipt).fingerprint, result.rawFingerprint);
    assert.deepEqual(fs.readFileSync(f.journalPath), before);
    for (const name of fs.readdirSync(f.dir)) assert.equal(fs.statSync(path.join(f.dir, name)).mode & 0o777, 0o600);
    for (const secret of ['SYNTHETIC_PRIVATE_TRANSCRIPT', 'SYNTHETIC_PRIVATE_CWD', 'SYNTHETIC_EVENT_DIAGNOSTIC', '"tool_input"']) {
      assert.ok(!JSON.stringify(artifactBytes(f)).includes(secret));
    }
  }
  finishReads(f);
  const assembled = assembleHookSources(f.dir, assemblyOptions(f));
  const input = readCaptureJson(assembled.path);
  assert.equal(assembled.status, 'assembled'); assert.equal(Object.keys(input.ib).length, 5); assert.equal(input.sharesight.length, 9);
  assert.equal(input.previousSourceSha, sha); assert.deepEqual(input.ib.accountSummary.raw, rawFor('ib.accountSummary'));
});

test('the native-object transport remains native and has equal hashes without source rewriting', t => {
  const f = fixture(t), armed = f.arm(), value = rawFor('ib.positions');
  const result = f.capture(armed, f.event('ib.positions', { tool_response: value }));
  assert.equal(result.wrapper, 'native-object'); assert.equal(result.transportFingerprint, result.rawFingerprint);
  assert.deepEqual(readCaptureJson(result.transportPath).toolResponse, value);
});

test('only actual read-only input schemas can arm; public probes and guessed tools cannot', t => {
  const f = fixture(t), key = CAPTURE_SOURCE_KEYS.find(key => key.startsWith('sharesight.'));
  const portfolio = key.slice('sharesight.'.length);
  assert.equal(SOURCE_HOOK_TOOLS.sharesight, 'mcp__Family_Portfolio_Sharesight__sharesight_get_performance');
  assert.equal(validateHookInput(key, { portfolio, start_date: null, end_date: '2026-09-05', grouping: 'investment_type', include_sales: false }),
    fingerprint({ portfolio, start_date: null, end_date: '2026-09-05', grouping: 'investment_type', include_sales: false }));
  assert.equal(validateHookInput('ib.trades', {}), fingerprint({}));
  assert.equal(validateHookInput('ib.trades', { period: 'TODAY' }), fingerprint({ period: 'TODAY' }));
  for (const [source, input] of [['ib.positions', { account: 'SYNTHETIC' }], ['ib.trades', { period: 'WEEK' }],
    [key, { portfolio: Number(portfolio) }], [key, { portfolio: '0' }], [key, { portfolio, include_sales: true }],
    [key, { portfolio, grouping: 'currency' }], [key, { portfolio, start_date: '2026-09-06', end_date: '2026-09-05' }]]) {
    assert.throws(() => validateHookInput(source, input), /INVALID_TOOL_INPUT/);
  }
  assert.throws(() => armHookSource(f.dir, 'ib.positions', { ...f.binding('ib.positions'), toolName: 'mcp__Interactive_Brokers__get_whats_new' }, f.options(10)), /INVALID_BINDING/);
  assert.throws(() => armHookSource(f.dir, 'ib.whats_new', f.binding('ib.positions'), f.options(10)), /INVALID_SOURCE_KEY/);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('unrelated tool/input events are ignored without consuming a claim or writing diagnostics', t => {
  const f = fixture(t), armed = f.arm(), before = artifactBytes(f);
  for (const changes of [{ tool_name: 'OTHER_TOOL' }, { tool_input: { unrelated: true } }, { tool_input: null }]) {
    assert.deepEqual(f.capture(armed, f.event('ib.positions', changes)), { status: 'ignored' });
    assert.deepEqual(artifactBytes(f), before); noClaim(f);
  }
  assert.equal(f.capture(armed).status, 'captured');
});

test('wrong runtime session, missing use ID, wrong event kind and wrong nonce fail before claiming', t => {
  for (const changes of [{ session_id: 'OTHER_SESSION' }, { tool_use_id: undefined }, { tool_use_id: '' },
    { tool_use_id: 5 }, { hook_event_name: 'PreToolUse' }]) {
    const f = fixture(t), armed = f.arm();
    assert.throws(() => f.capture(armed, f.event('ib.positions', changes)), /EVENT_BINDING_MISMATCH/); noClaim(f);
  }
  const f = fixture(t), armed = f.arm();
  assert.throws(() => captureHookSource(f.dir, 'ib.positions', '0'.repeat(48), bytes(f.event()), f.options(20)), /ARM_BINDING_MISMATCH/);
  assert.throws(() => captureHookSource(f.dir, 'ib.positions', 'bad', bytes(f.event()), f.options(20)), /INVALID_NONCE/); noClaim(f);
});

test('expired, future and modified-TTL arms cannot claim an event', t => {
  for (const offset of [9, 10 + HOOK_ARM_TTL_MS]) {
    const f = fixture(t), armed = f.arm();
    assert.throws(() => f.capture(armed, f.event(), offset), /ARM_NOT_CURRENT/); noClaim(f);
  }
  const f = fixture(t), armed = f.arm(), arm = readCaptureJson(armed.path);
  arm.expiresAt = new Date(Date.parse(arm.expiresAt) + 1000).toISOString(); writeJson(armed.path, arm);
  assert.throws(() => f.capture(armed), /ARM_NOT_CURRENT/); noClaim(f);
});

test('completed source stages and changed journal/begin/arm records fail without claiming', t => {
  for (const change of ['stage', 'journal', 'begin', 'arm']) {
    const f = fixture(t), armed = f.arm();
    if (change === 'stage') finishJournalStage(f.journalPath, 'ib-read', {}, f.clock(15));
    if (change === 'journal') fs.writeFileSync(f.journalPath, fs.readFileSync(f.journalPath, 'utf8').replace('"v":1', '"v": 1'));
    if (change === 'begin') {
      const file = path.join(f.dir, 'ib.positions.begin.json'); fs.writeFileSync(file, `${JSON.stringify(readCaptureJson(file), null, 2)}\n`);
    }
    if (change === 'arm') { const arm = readCaptureJson(armed.path); arm.runId = '0'.repeat(64); writeJson(armed.path, arm); }
    assert.throws(() => f.capture(armed), /READ_STAGE_NOT_ACTIVE|JOURNAL_PREFIX_CHANGED|ARM_RUN_CHANGED|INVALID_RUN_JOURNAL/); noClaim(f);
  }
});

test('unknown decode shapes retain the original private transport and consume the one-shot claim permanently', t => {
  for (const response of ['{"positions":[', { content: [{ type: 'text', text: '{"positions":[]}' }] },
    { wrong: [] }, JSON.stringify(JSON.stringify(rawFor('ib.positions'))), { positions: [], isError: true }]) {
    const f = fixture(t), armed = f.arm(), event = f.event('ib.positions', { tool_response: response });
    assert.throws(() => f.capture(armed, event), /CAPTURE_REJECTED/);
    assert.equal(fs.existsSync(f.file('ib.positions', 'claim')), true);
    assert.deepEqual(readCaptureJson(f.file('ib.positions', 'transport')).toolResponse, response);
    assert.equal(fs.existsSync(f.file('ib.positions', 'raw')), false); assert.equal(hasReceipt(f), false);
    assert.match(readCaptureJson(f.file('ib.positions', 'rejected')).errorCode, /^[A-Z0-9_]+$/);
    const before = artifactBytes(f);
    assert.throws(() => f.capture(armed), /ARTIFACT_ALREADY_EXISTS/);
    assert.deepEqual(artifactBytes(f), before);
    assert.throws(() => f.arm(), /EXISTING_HOOK_ARTIFACT/);
  }
});

test('failure or missing-response events retain only bounded rejection identity, never upstream diagnostics', t => {
  for (const changes of [{ hook_event_name: 'PostToolUseFailure', error: 'SYNTHETIC_SENSITIVE_ERROR' },
    { error: 'SYNTHETIC_SENSITIVE_ERROR' }, { error: false }, { isError: true }, { tool_response: undefined }]) {
    const f = fixture(t), armed = f.arm();
    assert.throws(() => f.capture(armed, f.event('ib.positions', changes)), /CAPTURE_REJECTED/);
    assert.equal(fs.existsSync(f.file('ib.positions', 'claim')), true);
    assert.equal(fs.existsSync(f.file('ib.positions', 'transport')), false);
    assert.equal(hasReceipt(f), false);
    assert.ok(!JSON.stringify(artifactBytes(f)).includes('SYNTHETIC_SENSITIVE_ERROR'));
  }
});

test('a successful duplicate event cannot overwrite transport, receipt or completion time', t => {
  const f = fixture(t), armed = f.arm(); f.capture(armed);
  const before = artifactBytes(f);
  assert.throws(() => f.capture(armed, f.event(), 21), /ARTIFACT_ALREADY_EXISTS/);
  assert.deepEqual(artifactBytes(f), before);
});

test('simultaneous capture processes have exactly one atomic winner with silent stdout', async t => {
  const f = fixture(t), armed = f.arm(), input = bytes(f.event());
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'capture', f.dir, 'ib.positions', armed.nonce], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.map(item => item.code).sort(), [0, 1]);
  assert.ok(results.every(item => item.stdout === ''));
  assert.equal(results.find(item => item.code === 1).stderr, 'XUAN-IB source hook: HOOK_OPERATION_FAILED\n');
  assert.equal(hasReceipt(f), true);
  assert.equal(fs.existsSync(f.file('ib.positions', 'rejected')), false, 'the losing duplicate must not invalidate the winner');
});

test('symlink directories/files and existing raw targets cannot be followed or overwritten', t => {
  const f = fixture(t), link = path.join(f.root, 'linked-captures'); fs.symlinkSync(f.dir, link);
  assert.throws(() => armHookSource(link, 'ib.positions', f.binding('ib.positions'), f.options(10)), /SYMLINK_PATH_REJECTED/);
  for (const mode of ['symlink', 'existing']) {
    const g = fixture(t), armed = g.arm(), target = path.join(g.root, 'keep.json'); writeJson(target, { keep: 'SYNTHETIC ORIGINAL' });
    const rawFile = g.file('ib.positions', 'raw');
    if (mode === 'symlink') fs.symlinkSync(target, rawFile); else writeJson(rawFile, { keep: 'SYNTHETIC ORIGINAL' });
    assert.throws(() => g.capture(armed), /CAPTURE_REJECTED/);
    assert.deepEqual(readCaptureJson(target), { keep: 'SYNTHETIC ORIGINAL' });
    if (mode === 'existing') assert.deepEqual(readCaptureJson(rawFile), { keep: 'SYNTHETIC ORIGINAL' });
    assert.equal(hasReceipt(g), false); assert.equal(fs.existsSync(g.file('ib.positions', 'claim')), true);
  }
});

test('bad UTF-8, duplicate event keys, nonfinite numbers and oversized events stop before claiming', t => {
  const f = fixture(t), armed = f.arm();
  for (const input of [Buffer.from([0xff]), Buffer.from('{"tool_name":"x","tool_name":"y"}'),
    Buffer.from('{"extra":1e400}'), Buffer.alloc(MAX_HOOK_EVENT_BYTES + 1), Buffer.alloc(0)]) {
    assert.throws(() => captureHookSource(f.dir, 'ib.positions', armed.nonce, input, f.options(20)), /INVALID_EVENT_JSON|INVALID_EVENT_SIZE/); noClaim(f);
  }
});

test('CLI capture success and ignores are silent; failures expose no paths or financial response bytes', async t => {
  const f = fixture(t), armed = f.arm();
  const ignored = spawnSync(process.execPath, [cliPath, 'capture', f.dir, 'ib.positions', armed.nonce],
    { input: bytes(f.event('ib.positions', { tool_name: 'unrelated' })), encoding: 'utf8' });
  assert.equal(ignored.status, 0); assert.equal(ignored.stdout, ''); assert.equal(ignored.stderr, ''); noClaim(f);
  const bad = spawnSync(process.execPath, [cliPath, 'capture', f.dir, 'ib.positions', armed.nonce],
    { input: Buffer.from([0xff]), encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, 'XUAN-IB source hook: HOOK_OPERATION_FAILED\n'); noClaim(f);
  const good = spawnSync(process.execPath, [cliPath, 'capture', f.dir, 'ib.positions', armed.nonce],
    { input: bytes(f.event()), encoding: 'utf8' });
  assert.equal(good.status, 0); assert.equal(good.stdout, ''); assert.equal(good.stderr, '');
  await assert.rejects(() => runSourceHookCli(['capture', f.dir, 'ib.positions', armed.nonce, '--force'], []), /INVALID_COMMAND_OR_FLAGS/);
});

test('finishing at the arm expiry cannot create a successful receipt after an initially timely claim', t => {
  const f = fixture(t), armed = f.arm();
  let calls = 0;
  assert.throws(() => captureHookSource(f.dir, 'ib.positions', armed.nonce, bytes(f.event()), {
    wallNow: () => f.base + (++calls === 1 ? 20 : 10 + HOOK_ARM_TTL_MS),
  }), /CAPTURE_REJECTED/);
  assert.equal(fs.existsSync(f.file('ib.positions', 'claim')), true);
  assert.equal(fs.existsSync(f.file('ib.positions', 'rejected')), true);
  assert.equal(hasReceipt(f), false);
});

test('hook assembler rejects tampered transport/raw/claim/arm/rejection and missing proof before producing input.json', t => {
  const f = fixture(t); captureAll(f); finishReads(f);
  const options = assemblyOptions(f), key = 'ib.positions';
  for (const [suffix, change, pattern] of [
    ['transport', value => { value.toolResponse = '{"positions":[{"synthetic":"changed"}]}'; }, /HOOK_RAW_CHANGED/],
    ['raw', value => { value.positions.push({ synthetic: 'changed' }); }, /HOOK_RAW_CHANGED/],
    ['claim', value => { value.nonce = '0'.repeat(48); }, /HOOK_CLAIM_CHANGED/],
    ['arm', value => { value.runtimeSessionId = 'CHANGED-RUNTIME'; }, /HOOK_CLAIM_CHANGED/],
    ['transport', value => { value.toolUseId = 'CHANGED-USE'; }, /HOOK_TRANSPORT_CHANGED/],
  ]) {
    const file = f.file(key, suffix), before = fs.readFileSync(file);
    const value = readCaptureJson(file); change(value); writeJson(file, value);
    assert.throws(() => assembleHookSources(f.dir, options), pattern);
    assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
    fs.writeFileSync(file, before);
  }
  const rejection = f.file(key, 'rejected'); writeJson(rejection, { errorCode: 'SYNTHETIC_FAILED' });
  assert.throws(() => assembleHookSources(f.dir, options), /REJECTED_OR_UNKNOWN_HOOK_ARTIFACT/);
  assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false); fs.unlinkSync(rejection);
  const missing = f.file(key, 'transport'), saved = fs.readFileSync(missing); fs.unlinkSync(missing);
  assert.throws(() => assembleHookSources(f.dir, options)); assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
  fs.writeFileSync(missing, saved, { flag: 'wx', mode: 0o600 });
  assert.equal(assembleHookSources(f.dir, options).status, 'assembled');
});

test('hook assembler refuses reused tool-use identity and mixed runtimes across otherwise valid fourteen sources', t => {
  for (const mode of ['duplicate', 'mixed']) {
    const f = fixture(t);
    captureAll(f, mode === 'duplicate' ? { useIdFor: () => 'SYNTHETIC-REUSED-USE' }
      : { runtimeFor: key => key === 'ib.positions' ? 'OTHER-RUNTIME' : 'SYNTHETIC-RUNTIME-SESSION' });
    finishReads(f);
    assert.throws(() => assembleHookSources(f.dir, assemblyOptions(f)), mode === 'duplicate' ? /DUPLICATE_HOOK_TOOL_USE/ : /MIXED_HOOK_RUNTIMES/);
    assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
  }
});

test('the ordinary assembler cannot bypass hook proof verification when the original begin identifies hook capture', t => {
  const f = fixture(t); captureAll(f); finishReads(f);
  for (const file of fs.readdirSync(f.dir).filter(name => name.includes('.hook-'))) {
    fs.unlinkSync(path.join(f.dir, file));
  }
  assert.equal(readCaptureJson(path.join(f.dir, 'ib.positions.begin.json')).kind, 'source-hook-begin-v1');
  assert.throws(() => assembleSourceCaptures(f.dir, assemblyOptions(f)));
  assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
});

test('hook assembler independently rejects a forged receipt completion after arm expiry even if run-stage times allow it', t => {
  const f = fixture(t); captureAll(f);
  const completed = 10 + HOOK_ARM_TTL_MS;
  const file = path.join(f.dir, 'ib.accountSummary.receipt.json'), envelope = readCaptureJson(file);
  envelope.receipt.completedAt = new Date(f.base + completed).toISOString(); writeJson(file, envelope);
  finishReads(f, completed + 10);
  assert.throws(() => assembleHookSources(f.dir, assemblyOptions(f, completed + 20)), /HOOK_RAW_CHANGED|HOOK_RECEIPT_OUTSIDE_ARM/);
  assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
});

test('hook assembly CLI uses the complete proof path and rejects incomplete capture artifacts', async t => {
  const f = fixture(t), armed = f.arm(); f.capture(armed); finishReads(f);
  const options = assemblyOptions(f);
  await assert.rejects(() => runSourceHookCli(['assemble', f.dir, '--journal', f.journalPath,
    '--previous-source-sha', sha, '--data-date', options.dataDate], []));
  assert.equal(fs.existsSync(path.join(f.dir, 'input.json')), false);
  await assert.rejects(() => runSourceHookCli(['assemble', f.dir, '--journal', f.journalPath, '--force'], []), /INVALID_COMMAND_OR_FLAGS/);
});

test('arm CLI reads a private minimal binding and reports only armed status, not financial success', t => {
  const f = fixture(t), file = path.join(f.root, 'binding.json'); writeJson(file, f.binding('ib.positions'));
  const result = spawnSync(process.execPath, [cliPath, 'arm', f.dir, 'ib.positions', file, '--journal', f.journalPath], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const arm = JSON.parse(result.stdout); assert.equal(arm.status, 'armed-not-authorized');
  assert.match(arm.nonce, /^[a-f0-9]{48}$/); noClaim(f); assert.equal(hasReceipt(f), false);
  const stored = readCaptureJson(arm.path); assert.equal(stored.inputFingerprint, fingerprint({}));
  assert.equal(Object.hasOwn(stored, 'toolInput'), false);
});
