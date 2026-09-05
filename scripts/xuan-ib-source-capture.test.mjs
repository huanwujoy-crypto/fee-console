import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_SOURCE_KEYS, beginSourceCapture, finishSourceCapture, assembleSourceCaptures, sourceCaptureCli,
  validateCaptureDirectory, validateCaptureFile, readCaptureJson, writeCaptureJson } from './xuan-ib-source-capture.mjs';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { fingerprint } from './xuan-ib-run-manifest.mjs';
import { sourceRecordFromRaw } from './xuan-ib-source-adapter.mjs';

const base = Date.parse('2026-09-05T05:00:00.000Z');
const sha = 'a'.repeat(40);
const cliPath = fileURLToPath(new URL('./xuan-ib-source-capture.mjs', import.meta.url));
const writeJson = (target, value) => fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const fixture = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-source-capture-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'captures'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  const clock = n => ({ wallNow: () => base + n, monotonicNowMs: () => n });
  initRunJournal(journalPath, clock(0));
  startJournalStage(journalPath, 'bootstrap', clock(1));
  finishJournalStage(journalPath, 'bootstrap', {}, clock(2));
  startJournalStage(journalPath, 'ib-read', clock(3));
  startJournalStage(journalPath, 'sharesight-read', clock(4));
  const options = n => ({ journalPath, wallNow: () => base + n });
  const raw = key => key === 'ib.accountSummary'
    ? { currency: 'USD', net_liquidation: 100, total_cash_value: 20, stock_market_value: 80 }
    : key.startsWith('ib.') ? { [key.slice(3)]: [] }
      : { result: { mode: 'read_only', portfolio: { id: Number(key.slice('sharesight.'.length)), currency_code: 'USD' },
        data: { report: { portfolio_id: Number(key.slice('sharesight.'.length)), value: 1, end_date: '2026-09-04', currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } } };
  const capture = (key, idx = 0, override = undefined) => {
    const rawFile = path.join(root, `${key}.native.json`);
    writeJson(rawFile, override ?? raw(key));
    beginSourceCapture(dir, key, options(5 + idx * 2));
    return finishSourceCapture(dir, key, rawFile, options(6 + idx * 2));
  };
  const complete = () => {
    finishJournalStage(journalPath, 'ib-read', {}, clock(90));
    finishJournalStage(journalPath, 'sharesight-read', {}, clock(91));
  };
  const assemble = () => assembleSourceCaptures(dir, { ...options(100), previousSourceSha: sha, dataDate: '2026-09-05' });
  return { root, dir, journalPath, clock, options, raw, capture, complete, assemble };
};

test('captures exact 5 IB and 9 Sharesight bodies, private local intervals and adapter-compatible receipts', t => {
  const f = fixture(t);
  assert.equal(CAPTURE_SOURCE_KEYS.length, 14);
  assert.ok(!CAPTURE_SOURCE_KEYS.includes('sharesight.1021747'));
  for (const [idx, key] of CAPTURE_SOURCE_KEYS.entries()) {
    const before = fs.readFileSync(f.journalPath);
    const captured = f.capture(key, idx);
    assert.equal(captured.status, 'captured');
    assert.deepEqual(fs.readFileSync(f.journalPath), before, 'capture does not write journal');
    assert.equal(fs.statSync(captured.path).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(captured).includes('net_liquidation'));
  }
  f.complete();
  const result = f.assemble(), input = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.equal(result.status, 'assembled'); assert.equal(path.basename(result.path), 'input.json');
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(input.edition, 'adhoc'); assert.equal(input.previousSourceSha, sha);
  assert.equal(Object.keys(input.ib).length, 5); assert.equal(input.sharesight.length, 9);
  assert.deepEqual(input.ib.accountSummary.raw, f.raw('ib.accountSummary'));
  assert.equal(input.ib.accountSummary.startedAt, new Date(base + 5).toISOString());
  assert.equal(input.ib.accountSummary.completedAt, new Date(base + 6).toISOString());
  assert.equal(input.ib.accountSummary.rawFingerprint, fingerprint(f.raw('ib.accountSummary')));
  assert.equal(sourceRecordFromRaw(input.ib.accountSummary.raw, input.ib.accountSummary).status, 'ok');
  assert.throws(f.assemble, /OUTPUT_ALREADY_EXISTS/);
});

test('begin and finish cannot overwrite an existing capture', t => {
  const f = fixture(t); const key = 'ib.positions';
  f.capture(key);
  assert.throws(() => beginSourceCapture(f.dir, key, f.options(8)), /OUTPUT_ALREADY_EXISTS/);
  assert.throws(() => finishSourceCapture(f.dir, key, path.join(f.root, `${key}.native.json`), f.options(8)), /OUTPUT_ALREADY_EXISTS/);
});

test('source keys are exact allowlist, including forbidden portfolio rejection', t => {
  const f = fixture(t);
  for (const key of ['ib.createOrder', 'sharesight.1021747', '../bad', 'ib.positions/other', 'sharesight.0936247']) {
    assert.throws(() => beginSourceCapture(f.dir, key, f.options(8)), /INVALID_SOURCE_KEY/);
  }
});

test('begin needs active source stage and completed bootstrap', t => {
  const f = fixture(t);
  f.complete();
  assert.throws(() => beginSourceCapture(f.dir, 'ib.positions', f.options(95)), /READ_STAGE_NOT_ACTIVE/);
  const journalPath = path.join(f.root, 'not-bootstrapped.jsonl');
  initRunJournal(journalPath, f.clock(0)); startJournalStage(journalPath, 'ib-read', f.clock(1));
  assert.throws(() => beginSourceCapture(f.dir, 'ib.positions', { journalPath, wallNow: () => base + 3 }), /BOOTSTRAP_NOT_COMPLETE/);
});

test('finish needs begin, same run and a still-active source stage', t => {
  const f = fixture(t), rawFile = path.join(f.root, 'raw.json'); writeJson(rawFile, { positions: [] });
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(8)), /PRIVATE_PATH_UNAVAILABLE/);
  beginSourceCapture(f.dir, 'ib.positions', f.options(8));
  f.complete();
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(95)), /READ_STAGE_NOT_ACTIVE/);
});

test('journal substitution, init change and prefix mutation are rejected', t => {
  const f = fixture(t), rawFile = path.join(f.root, 'raw.json'); writeJson(rawFile, { positions: [] });
  beginSourceCapture(f.dir, 'ib.positions', f.options(8));
  const original = fs.readFileSync(f.journalPath, 'utf8');
  const lines = original.trimEnd().split('\n').map(JSON.parse); lines[0].wallMs -= 1;
  fs.writeFileSync(f.journalPath, `${lines.map(JSON.stringify).join('\n')}\n`);
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /BEGIN_RUN_BINDING_MISMATCH/);
  fs.writeFileSync(f.journalPath, original);
  const beginPath = path.join(f.dir, 'ib.positions.begin.json');
  const begin = JSON.parse(fs.readFileSync(beginPath, 'utf8')); begin.journalPrefixFingerprint = '0'.repeat(64); writeJson(beginPath, begin);
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /JOURNAL_PREFIX_CHANGED/);
});

test('strict JSON rejects duplicate keys, invalid UTF8, excessive nesting, non-finite numbers and MCP wrappers', t => {
  const f = fixture(t), rawFile = path.join(f.root, 'raw.json');
  beginSourceCapture(f.dir, 'ib.positions', f.options(8));
  for (const source of ['{"positions":[],"positions":[]}', '{"positions":[],"x":1e999}', '['.repeat(34) + '0' + ']'.repeat(34), Buffer.from([0xff]), '{"content":[{"type":"text","text":"secret"}]}']) {
    fs.writeFileSync(rawFile, source, { mode: 0o600 });
    assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /INVALID_STRICT_JSON|UNSUPPORTED_NATIVE_SOURCE_SHAPE/);
    assert.equal(fs.existsSync(path.join(f.dir, 'ib.positions.receipt.json')), false);
  }
});

test('portfolio payload cannot claim another source key', t => {
  const f = fixture(t), key = 'sharesight.936247', rawFile = path.join(f.root, 'raw.json');
  writeJson(rawFile, f.raw('sharesight.936238')); beginSourceCapture(f.dir, key, f.options(8));
  assert.throws(() => finishSourceCapture(f.dir, key, rawFile, f.options(10)), /PORTFOLIO_SOURCE_KEY_MISMATCH/);
});

test('upstream error produces private failed receipt, never successful first-trial assembly', t => {
  const f = fixture(t);
  for (const [idx, key] of CAPTURE_SOURCE_KEYS.entries()) {
    const result = f.capture(key, idx, key === 'ib.positions' ? { isError: true, error: 'UPSTREAM_PRIVATE_DETAIL' } : undefined);
    if (key === 'ib.positions') {
      assert.equal(result.status, 'failed');
      const envelope = JSON.parse(fs.readFileSync(result.path, 'utf8'));
      assert.equal(envelope.receipt.status, 'failed'); assert.equal(envelope.receipt.errorCode, 'UPSTREAM_SOURCE_ERROR');
      assert.equal(envelope.receipt.raw.error, 'UPSTREAM_PRIVATE_DETAIL');
      assert.ok(!JSON.stringify(result).includes('UPSTREAM_PRIVATE_DETAIL'));
    }
  }
  f.complete(); assert.throws(f.assemble, /FAILED_SOURCE_REQUIRES_STOP/);
});

test('assemble requires all fourteen reads, stage completion and same actual HKT date', t => {
  const f = fixture(t); f.capture('ib.accountSummary');
  assert.throws(f.assemble, /READ_STAGES_STILL_ACTIVE/); f.complete();
  assert.throws(f.assemble, /PRIVATE_PATH_UNAVAILABLE/);
  for (const [idx, key] of CAPTURE_SOURCE_KEYS.slice(1).entries()) {
    // Completing stages cannot retrospectively start a missing real read.
    assert.throws(() => f.capture(key, idx + 1), /READ_STAGE_NOT_ACTIVE/);
  }
});

test('assemble refuses tampered raw and changed begin files', t => {
  const f = fixture(t); CAPTURE_SOURCE_KEYS.forEach((key, idx) => f.capture(key, idx)); f.complete();
  const target = path.join(f.dir, 'ib.accountSummary.receipt.json');
  const envelope = JSON.parse(fs.readFileSync(target, 'utf8')); envelope.receipt.raw.net_liquidation += 1; writeJson(target, envelope);
  assert.throws(f.assemble, /CAPTURE_HASH_OR_RECEIPT_CHANGED/);
  envelope.receipt.raw.net_liquidation -= 1; writeJson(target, envelope);
  const beginPath = path.join(f.dir, 'ib.accountSummary.begin.json'), original = fs.readFileSync(beginPath);
  fs.writeFileSync(beginPath, Buffer.concat([original, Buffer.from(' ')]));
  assert.throws(f.assemble, /FINISH_RUN_BINDING_MISMATCH/);
});

test('assemble rejects wrong dates, future completion, unknown captures and failed stage', t => {
  const f = fixture(t); CAPTURE_SOURCE_KEYS.forEach((key, idx) => f.capture(key, idx)); f.complete();
  for (const dataDate of ['2026-09-04', '2026-09-06', '2026-02-30']) {
    assert.throws(() => assembleSourceCaptures(f.dir, { ...f.options(100), previousSourceSha: sha, dataDate }), /CAPTURE_DATE_MISMATCH|INVALID_DATA_DATE/);
  }
  assert.throws(() => assembleSourceCaptures(f.dir, { ...f.options(5), previousSourceSha: sha, dataDate: '2026-09-05' }), /CAPTURE_OUTSIDE_COMPLETED_STAGE/);
  writeJson(path.join(f.dir, 'sharesight.1021747.receipt.json'), {}); assert.throws(f.assemble, /UNEXPECTED_CAPTURE_SOURCE/);
});

test('private directory, file permissions, symlinks, hardlinks and Git ancestor checks are enforced', t => {
  const f = fixture(t);
  fs.chmodSync(f.dir, 0o755); assert.throws(() => beginSourceCapture(f.dir, 'ib.positions', f.options(8)), /DIRECTORY_MUST_BE_0700/); fs.chmodSync(f.dir, 0o700);
  const symlink = path.join(f.root, 'linked'); fs.symlinkSync(f.dir, symlink);
  assert.throws(() => beginSourceCapture(symlink, 'ib.positions', f.options(8)), /SYMLINK_PATH_REJECTED/);
  assert.throws(() => beginSourceCapture('relative', 'ib.positions', f.options(8)), /ABSOLUTE_PRIVATE_PATH_REQUIRED/);
  const gitDir = path.join(f.root, 'repo'); fs.mkdirSync(gitDir, { mode: 0o700 }); fs.mkdirSync(path.join(gitDir, '.git'));
  const privateChild = path.join(gitDir, 'private'); fs.mkdirSync(privateChild, { mode: 0o700 });
  assert.throws(() => beginSourceCapture(privateChild, 'ib.positions', f.options(8)), /GIT_PRIVATE_PATH_REJECTED/);
  const rawFile = path.join(f.root, 'raw.json'); writeJson(rawFile, { positions: [] });
  beginSourceCapture(f.dir, 'ib.positions', f.options(8));
  fs.chmodSync(rawFile, 0o644); assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /FILE_MUST_BE_PRIVATE_REGULAR_0600/); fs.chmodSync(rawFile, 0o600);
  fs.linkSync(rawFile, path.join(f.root, 'raw-copy.json')); assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /FILE_MUST_BE_PRIVATE_REGULAR_0600/);
});

test('raw files are bounded and clock cannot move backwards', t => {
  const f = fixture(t), rawFile = path.join(f.root, 'raw.json');
  beginSourceCapture(f.dir, 'ib.positions', f.options(8));
  fs.writeFileSync(rawFile, ' '.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(10)), /PRIVATE_FILE_SIZE_OR_MODE/);
  writeJson(rawFile, { positions: [] });
  assert.throws(() => finishSourceCapture(f.dir, 'ib.positions', rawFile, f.options(7)), /CAPTURE_CLOCK_MOVED_BACKWARDS/);
});

test('CLI allows only exact commands, rejects clock flags and does not leak raw errors or caller paths', t => {
  const f = fixture(t);
  assert.throws(() => sourceCaptureCli(['begin', f.dir, 'ib.positions', '--journal', f.journalPath, '--now', String(base)]), /INVALID_COMMAND_OR_FLAGS/);
  const result = spawnSync(process.execPath, [cliPath, 'finish', f.dir, 'ib.positions', '/SECRET_RAW_FILE', '--journal', f.journalPath], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('/SECRET_RAW_FILE')); assert.ok(!result.stderr.includes(f.root));
});

test('prepare private IO wrappers retain strict JSON, immutable output and fixed filename boundaries', t => {
  const f = fixture(t);
  assert.equal(validateCaptureDirectory(f.dir), f.dir);
  assert.equal(validateCaptureFile(f.journalPath), f.journalPath);
  const output = writeCaptureJson(f.dir, 'view.json', { schemaVersion: 1 });
  assert.deepEqual(readCaptureJson(output), { schemaVersion: 1 });
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeCaptureJson(f.dir, 'view.json', {}), /OUTPUT_ALREADY_EXISTS/);
  for (const name of ['../escaped.json', '/absolute.json', 'nested/view.json', 'candidate.html', '.git', 'anything.json']) {
    assert.throws(() => writeCaptureJson(f.dir, name, {}), /INVALID_PRIVATE_JSON_OUTPUT_NAME/);
  }
  assert.throws(() => readCaptureJson(output, Infinity), /INVALID_PRIVATE_READ_LIMIT/);
  fs.writeFileSync(output, '{"x":1,"x":2}');
  assert.throws(() => readCaptureJson(output), /INVALID_STRICT_JSON/);
});
