import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { TREND_METHOD } from './xuan-ib-etf-trend.mjs';
import { buildTrend, ETF_KEY_ENCRYPTION_LIMIT } from './xuan-ib-etf-trend-build.mjs';
import { decryptEtfTrend } from './xuan-ib-etf-trend-envelope.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/xuan-ib-etf-trend-build.mjs');
const NOW = '2026-09-04T02:00:00Z';
// Old dates keep the actual CLI test independent of the test runner's wall clock.
// All values and source references here are deliberately synthetic.
const START = '2020-09-01', LAST = '2020-09-02';
function source() {
  return { methodId: TREND_METHOD, startDate: START, frozenDate: '2020-09-04',
    initialUsd: 1234567, reserveUsd: 240000,
    days: [START, LAST].map((date, i) => ({ date, actualUsd: 1234567 + i * 4321,
      actualComplete: true, flowsComplete: true, flows: [], sourceRef: 'SYNTHETIC-PRIVATE-SOURCE-REF',
      quotes: Object.fromEntries(['CSPX', 'EXUS', 'EIMI', 'USSC'].map(symbol => [symbol,
        { status: 'close', usd: 100 + i, date, source: 'SYNTHETIC-QUOTE' }])) })) };
}
const makeRoot = parent => {
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-etf-build-'));
  fs.chmodSync(root, 0o700);
  return root;
};
function fixture(t) {
  const root = makeRoot(fs.realpathSync(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), previewRoot = path.join(root, 'preview'), keyUsageRoot = path.join(root, 'key-usage');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(previewRoot, { mode: 0o700 });
  fs.mkdirSync(keyUsageRoot, { mode: 0o700 });
  const inputPath = path.join(sourceRoot, 'synthetic-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(source()), { flag: 'wx', mode: 0o600 });
  return { root, sourceRoot, previewRoot, keyUsageRoot, inputPath,
    envelopePath: path.join(root, 'synthetic-trend.enc.json'),
    keyEncoded: randomBytes(32).toString('base64url'), now: NOW };
}
const mode = file => fs.statSync(file).mode & 0o777;
const previewFiles = root => [path.join(root, `result-${LAST}.json`), path.join(root, `preview-${LAST}.html`)];
const empty = root => assert.deepEqual(fs.readdirSync(root), []);

test('private preview and encrypted output are 0600; only metadata is returned', async t => {
  const f = fixture(t), metadata = await buildTrend(f);
  assert.equal(mode(f.sourceRoot), 0o700);
  assert.equal(mode(f.previewRoot), 0o700);
  for (const file of [...previewFiles(f.previewRoot), f.envelopePath]) assert.equal(mode(file), 0o600);
  assert.deepEqual(metadata, { asOf: LAST, completeThrough: LAST, rows: 2, encrypted: true, preview: true });
  const clear = await decryptEtfTrend(fs.readFileSync(f.envelopePath), f.keyEncoded, { now: NOW });
  assert.equal(clear.result.initialUsd, 1234567);
  const ciphertextText = fs.readFileSync(f.envelopePath, 'utf8');
  for (const text of ['1234567', 'SYNTHETIC-PRIVATE-SOURCE-REF', 'endingUsd', 'sourceRef', f.keyEncoded]) {
    assert.equal(ciphertextText.includes(text), false);
  }
});

test('missing encryption key creates neither preview nor encrypted output', async t => {
  const f = fixture(t);
  await assert.rejects(buildTrend({ ...f, keyEncoded: null }), /key|KEY/);
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('invalid encryption key also creates no outputs', async t => {
  const f = fixture(t);
  await assert.rejects(buildTrend({ ...f, keyEncoded: 'not-a-valid-32-byte-key' }));
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('preview-only mode does not need or discover a key', async t => {
  const f = fixture(t);
  const metadata = await buildTrend({ inputPath: f.inputPath, previewRoot: f.previewRoot, now: NOW });
  assert.equal(metadata.encrypted, false);
  assert.equal(metadata.preview, true);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('standard padded base64 key is normalized only at the builder boundary', async t => {
  const f = fixture(t);
  const standard = Buffer.from(f.keyEncoded, 'base64url').toString('base64');
  await buildTrend({ ...f, keyEncoded: standard });
  const clear = await decryptEtfTrend(fs.readFileSync(f.envelopePath), f.keyEncoded, { now: NOW });
  assert.equal(clear.result.initialUsd, 1234567);
});

test('source root must have exactly 0700 permissions', async t => {
  const f = fixture(t); fs.chmodSync(f.sourceRoot, 0o750);
  await assert.rejects(buildTrend(f), /0700/);
  empty(f.previewRoot);
});

test('preview root must have exactly 0700 permissions', async t => {
  const f = fixture(t); fs.chmodSync(f.previewRoot, 0o755);
  await assert.rejects(buildTrend(f), /0700/);
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('source file must have exactly 0600 permissions', async t => {
  const f = fixture(t); fs.chmodSync(f.inputPath, 0o640);
  await assert.rejects(buildTrend(f), /private input/);
  empty(f.previewRoot);
});

test('source leaf symlink is not followed', async t => {
  const f = fixture(t), alias = path.join(f.sourceRoot, 'symlink.json');
  fs.symlinkSync(f.inputPath, alias);
  await assert.rejects(buildTrend({ ...f, inputPath: alias }));
  empty(f.previewRoot);
});

test('hard-linked input is rejected even when mode and owner match', async t => {
  const f = fixture(t); fs.linkSync(f.inputPath, path.join(f.sourceRoot, 'second-link.json'));
  await assert.rejects(buildTrend(f), /private input/);
  empty(f.previewRoot);
});

test('symlink source and preview directory aliases are rejected', async t => {
  const f = fixture(t), alias = path.join(f.root, 'source-alias'), previewAlias = path.join(f.root, 'preview-alias');
  fs.symlinkSync(f.sourceRoot, alias, 'dir');
  fs.symlinkSync(f.previewRoot, previewAlias, 'dir');
  await assert.rejects(buildTrend({ ...f, inputPath: path.join(alias, path.basename(f.inputPath)) }), /0700/);
  await assert.rejects(buildTrend({ ...f, previewRoot: previewAlias }), /0700/);
  empty(f.previewRoot);
});

test('raw input inside the public repository is rejected', async t => {
  const f = fixture(t), inRepo = makeRoot(REPO);
  t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));
  const raw = path.join(inRepo, 'synthetic-raw.json');
  fs.writeFileSync(raw, JSON.stringify(source()), { mode: 0o600, flag: 'wx' });
  await assert.rejects(buildTrend({ ...f, inputPath: raw }), /outside repository/);
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('plaintext preview destination inside public repository is rejected', async t => {
  const f = fixture(t), inRepo = makeRoot(REPO);
  t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));
  await assert.rejects(buildTrend({ ...f, previewRoot: inRepo }), /outside repository/);
  empty(inRepo);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('existing preview prevents every new output and is not overwritten', async t => {
  const f = fixture(t), existing = previewFiles(f.previewRoot)[0];
  fs.writeFileSync(existing, 'SYNTHETIC-EXISTING', { flag: 'wx', mode: 0o600 });
  await assert.rejects(buildTrend(f), /exists/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'SYNTHETIC-EXISTING');
  assert.deepEqual(fs.readdirSync(f.previewRoot), [path.basename(existing)]);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('existing ciphertext prevents new private previews and is retained', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.envelopePath, 'SYNTHETIC-EXISTING', { flag: 'wx', mode: 0o600 });
  await assert.rejects(buildTrend(f), /exists/);
  assert.equal(fs.readFileSync(f.envelopePath, 'utf8'), 'SYNTHETIC-EXISTING');
  empty(f.previewRoot);
});

test('dangling output symlink is detected before any preview is written', async t => {
  const f = fixture(t), target = path.join(f.root, 'must-not-create.json');
  fs.symlinkSync(target, f.envelopePath);
  await assert.rejects(buildTrend(f));
  assert.equal(fs.lstatSync(f.envelopePath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), false);
  empty(f.previewRoot);
});

test('oversized and malformed UTF-8 inputs create no outputs', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.inputPath, Buffer.alloc(2_000_001));
  await assert.rejects(buildTrend(f), /private input/);
  fs.writeFileSync(f.inputPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(buildTrend(f));
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('CLI stdout is metadata only; synthetic key and amounts are never emitted', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [SCRIPT, '--input', f.inputPath,
    '--preview-root', f.previewRoot, '--envelope-out', f.envelopePath, '--key-usage-root', f.keyUsageRoot], {
    encoding: 'utf8', env: { PATH: path.dirname(process.execPath), XUAN_ETF_DATA_KEY: f.keyEncoded },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, asOf: LAST, completeThrough: LAST,
    rows: 2, encrypted: true, preview: true });
  for (const text of ['1234567', 'SYNTHETIC-PRIVATE-SOURCE-REF', f.keyEncoded, f.inputPath]) {
    assert.equal(child.stdout.includes(text), false);
  }
});

test('CLI failure uses generic diagnostic and writes no output when key is absent', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [SCRIPT, '--input', f.inputPath,
    '--preview-root', f.previewRoot, '--envelope-out', f.envelopePath, '--key-usage-root', f.keyUsageRoot], {
    encoding: 'utf8', env: { PATH: path.dirname(process.execPath) },
  });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /Trend build failed/);
  assert.equal(child.stderr.includes(f.inputPath), false);
  assert.equal(child.stderr.includes('1234567'), false);
  empty(f.previewRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

function audit(f) {
  const entries = fs.readdirSync(f.keyUsageRoot);
  const dirs = entries.filter(name => name.startsWith('key-')).map(name => path.join(f.keyUsageRoot, name));
  return { entries, dirs, records: dirs.flatMap(dir => fs.readdirSync(dir).map(name => ({
    file: path.join(dir, name), record: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
  }))) };
}
const cipherOnly = (f, name, extra = {}) => ({ ...f, previewRoot: null,
  envelopePath: path.join(f.root, `${name}.enc.json`), ...extra });
const sha = text => createHash('sha256').update(text).digest('hex');

test('encrypted builds require an explicit stable private key usage root', async t => {
  const f = fixture(t);
  await assert.rejects(buildTrend({ ...f, keyUsageRoot: null }), /usage root/);
  empty(f.previewRoot); empty(f.keyUsageRoot);
  assert.equal(fs.existsSync(f.envelopePath), false);
});

test('key usage root rejects wrong permissions, symlink and public repository', async t => {
  const f = fixture(t), alias = path.join(f.root, 'usage-alias');
  fs.chmodSync(f.keyUsageRoot, 0o750);
  await assert.rejects(buildTrend(f), /0700/);
  fs.chmodSync(f.keyUsageRoot, 0o700);
  fs.symlinkSync(f.keyUsageRoot, alias, 'dir');
  await assert.rejects(buildTrend({ ...f, keyUsageRoot: alias }), /0700/);
  const inRepo = makeRoot(REPO); t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));
  await assert.rejects(buildTrend({ ...f, keyUsageRoot: inRepo }), /outside repository/);
  empty(f.keyUsageRoot); empty(f.previewRoot);
});

test('preflight failures and preview-only work consume no encryption quota', async t => {
  const f = fixture(t);
  await assert.rejects(buildTrend({ ...f, keyEncoded: null }));
  await assert.rejects(buildTrend({ ...f, keyEncoded: 'bad' }));
  await assert.rejects(buildTrend({ ...f, inputPath: path.join(f.sourceRoot, 'absent.json') }));
  await assert.rejects(buildTrend({ ...f, envelopePath: path.join(f.root, 'absent-dir', 'out.json') }));
  await assert.rejects(buildTrend({ ...f, previewRoot: null, envelopePath: null }));
  fs.writeFileSync(f.envelopePath, 'existing-synthetic', { flag: 'wx', mode: 0o600 });
  await assert.rejects(buildTrend(f), /exists/);
  empty(f.keyUsageRoot);
  await buildTrend({ inputPath: f.inputPath, previewRoot: f.previewRoot, now: NOW });
  empty(f.keyUsageRoot);
});

test('quota records are immutable 0600, sequential, fingerprinted and key-free', async t => {
  const f = fixture(t);
  await buildTrend(cipherOnly(f, 'one'));
  const first = audit(f), firstBytes = fs.readFileSync(first.records[0].file);
  // Alternate textual encoding of the same key bytes must share the quota.
  await buildTrend(cipherOnly(f, 'two', { keyEncoded: Buffer.from(f.keyEncoded, 'base64url').toString('base64') }));
  const second = audit(f);
  assert.deepEqual(second.records.map(r => r.record.sequence), [1, 2]);
  assert.deepEqual(fs.readFileSync(first.records[0].file), firstBytes);
  assert.equal(mode(second.dirs[0]), 0o700);
  for (const entry of second.entries) {
    const file = path.join(f.keyUsageRoot, entry);
    if (fs.statSync(file).isFile()) {
      assert.equal(mode(file), 0o600);
      assert.equal(fs.readFileSync(file, 'utf8').includes(f.keyEncoded), false);
    }
  }
  for (const { file, record } of second.records) {
    assert.equal(mode(file), 0o600);
    assert.match(record.keyFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(file, 'utf8').includes(f.keyEncoded), false);
  }
  assert.equal(second.entries.some(name => name.endsWith('.lock')), false);
});

test('concurrent processes allocate distinct immutable attempt sequence numbers', async t => {
  const f = fixture(t);
  const children = Array.from({ length: 6 }, (_, i) => new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, '--input', f.inputPath, '--envelope-out',
      path.join(f.root, `concurrent-${i}.enc.json`), '--key-usage-root', f.keyUsageRoot], {
      env: { PATH: path.dirname(process.execPath), XUAN_ETF_DATA_KEY: f.keyEncoded }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  }));
  const completed = await Promise.all(children);
  completed.forEach(result => { assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true); });
  assert.deepEqual(audit(f).records.map(row => row.record.sequence), [1, 2, 3, 4, 5, 6]);
});

test('a real encryption failure burns its reserved quota without writing outputs', async t => {
  const f = fixture(t), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      encrypt: async () => { throw new Error('synthetic encryption failure'); },
    },
  } });
  try { await assert.rejects(buildTrend(f), /synthetic encryption failure/); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(audit(f).records.map(row => row.record.sequence), [1]);
  empty(f.previewRoot); assert.equal(fs.existsSync(f.envelopePath), false);
  await buildTrend(f);
  assert.deepEqual(audit(f).records.map(row => row.record.sequence), [1, 2]);
});

test('10,000 attempts is a hard stop; only deliberate new key gets separate quota', async t => {
  const f = fixture(t); await buildTrend(cipherOnly(f, 'first'));
  const initial = audit(f), dir = initial.dirs[0], template = initial.records[0].record;
  const journal = path.join(f.keyUsageRoot, initial.entries.find(name => name.startsWith('usage-')));
  let previousHash = sha(fs.readFileSync(initial.records[0].file));
  const appended = [];
  for (let sequence = 2; sequence < ETF_KEY_ENCRYPTION_LIMIT; sequence++) {
    const record = JSON.stringify({ ...template, sequence, previousHash });
    fs.writeFileSync(path.join(dir, `attempt-${String(sequence).padStart(5, '0')}.json`), record, { flag: 'wx', mode: 0o600 });
    previousHash = sha(record); appended.push(`${String(sequence).padStart(5, '0')} ${previousHash}\n`);
  }
  fs.appendFileSync(journal, appended.join(''));
  await buildTrend(cipherOnly(f, 'last-permitted'));
  assert.equal(fs.readdirSync(dir).length, ETF_KEY_ENCRYPTION_LIMIT);
  const journalBefore = fs.readFileSync(journal);
  await assert.rejects(buildTrend(cipherOnly(f, 'over-limit')), /limit reached/);
  assert.equal(fs.readdirSync(dir).length, ETF_KEY_ENCRYPTION_LIMIT);
  assert.deepEqual(fs.readFileSync(journal), journalBefore);
  assert.equal(fs.existsSync(path.join(f.root, 'over-limit.enc.json')), false);
  await buildTrend(cipherOnly(f, 'rotated', { keyEncoded: randomBytes(32).toString('base64url') }));
  const after = audit(f);
  assert.equal(after.dirs.length, 2);
  assert.deepEqual(after.dirs.map(d => fs.readdirSync(d).length).sort((a, b) => a - b), [1, 10000]);
});

test('missing last attempt, removed directory or changed identity never silently resets quota', async t => {
  for (const corruption of ['last-record', 'directory', 'identity', 'permissions']) {
    const f = fixture(t); await buildTrend(cipherOnly(f, 'first')); await buildTrend(cipherOnly(f, 'second')); const a = audit(f);
    if (corruption === 'last-record') fs.unlinkSync(a.records.at(-1).file);
    if (corruption === 'directory') fs.rmSync(a.dirs[0], { recursive: true });
    if (corruption === 'identity') {
      const file = path.join(f.keyUsageRoot, a.entries.find(name => name.startsWith('registered-')));
      const identity = JSON.parse(fs.readFileSync(file, 'utf8')); identity.limit = 20000;
      fs.writeFileSync(file, JSON.stringify(identity));
    }
    if (corruption === 'permissions') fs.chmodSync(a.records[0].file, 0o644);
    await assert.rejects(buildTrend(cipherOnly(f, 'after-corruption')), /usage|Registered/);
    assert.equal(fs.existsSync(path.join(f.root, 'after-corruption.enc.json')), false);
  }
});
