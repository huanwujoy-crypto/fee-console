import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditEtfLedgerEntries,
  auditGitRepository,
  collectTrackedAndChangedPaths,
  PUBLIC_ETF_LEDGER_CHECKPOINT,
} from './xuan-ib-etf-ledger-leak-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const publicGenesis = fs.readFileSync(path.join(repo, PUBLIC_ETF_LEDGER_CHECKPOINT), 'utf8');
const privateLedger = JSON.stringify({
  schemaVersion: 1,
  mode: 'read-only-private-ledger',
  records: [{ sequence: 0, payload: { NAV: 123456.78, holdings: [{ units: 10 }] } }],
});

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test('the current tracked repository contains only the approved value-free public checkpoint', () => {
  const result = auditGitRepository({ cwd: repo });
  assert.deepEqual(result.violations, []);
  assert.ok(result.fileCount > 0);
});

test('only the exact public genesis path can contain the whitelisted checkpoint', () => {
  assert.deepEqual(auditEtfLedgerEntries([
    { path: PUBLIC_ETF_LEDGER_CHECKPOINT, content: publicGenesis },
  ]), []);
  for (const filePath of [
    'claude/xuan-ib-etf-ledger-copy.json',
    'exports/ETF-measurement-ledger.json',
    'archive/ledger-etf.json',
    'archive/etf/ledger.json',
    'archive/ledger/etf.json',
  ]) {
    assert.match(auditEtfLedgerEntries([{ path: filePath, content: publicGenesis }])[0].reason, /only/);
  }
});

test('the public checkpoint path fails closed on extra fields, values, or noncanonical bytes', () => {
  const checkpoint = JSON.parse(publicGenesis);
  for (const content of [
    JSON.stringify({ ...checkpoint, holdings: [] }) + '\n',
    JSON.stringify({ ...checkpoint, NAV: 1 }) + '\n',
    JSON.stringify({ ...checkpoint, commitmentKeyId: undefined }) + '\n',
    JSON.stringify({ ...checkpoint, baselineStatus: 'established', entryCount: 2 }) + '\n',
    JSON.stringify({ ...checkpoint, previousCheckpointHash: 'a'.repeat(64) }) + '\n',
    ` ${publicGenesis}`,
  ]) {
    assert.equal(auditEtfLedgerEntries([
      { path: PUBLIC_ETF_LEDGER_CHECKPOINT, content },
    ]).length, 1);
  }
});

test('private-ledger names are denied regardless of extension or contents', () => {
  for (const filePath of [
    'tmp/xuan-private-ledger.enc',
    'tmp/PRIVATE_LEDGER.backup',
    'private.ledger/opaque.bin',
    'tmp/ledger-private.backup',
    'tmp/privateLedger.bin',
  ]) {
    assert.match(auditEtfLedgerEntries([{ path: filePath, content: 'opaque' }])[0].reason, /naming/);
  }
});

test('disguised JSON ledger shapes are rejected without printing private values', () => {
  const examples = [
    privateLedger,
    JSON.stringify({ records: [{ payload: { status: 'pending' } }] }),
    JSON.stringify({ NAV: null, holdings: [] }),
    JSON.stringify({ positions: [{ ticker: 'SECRET', units: 12 }] }),
    JSON.stringify({ kind: 'ETF measurement ledger', holdings: [{ marketValue: 500 }] }),
    JSON.stringify({
      evidenceId: 'xuan-ib-etf-t0-baseline-evidence-v1',
      holdings: [{ quantity: '1000.00', unitPriceUsd: '1' }],
    }),
  ];
  for (const content of examples) {
    const [violation] = auditEtfLedgerEntries([{ path: 'innocent-looking/cache.txt', content }]);
    assert.ok(violation);
    assert.doesNotMatch(violation.reason, /123456|SECRET|500/);
  }
});

test('descriptive prose, source code, and value-free classification JSON do not false-positive', () => {
  const entries = [
    {
      path: 'docs/privacy.md',
      content: 'Describe records, payload, NAV, holdings, positions, units and live amounts without storing them.',
    },
    {
      path: 'scripts/example.mjs',
      content: "const warning = 'Never commit a private ETF ledger payload or NAV';\n",
    },
    {
      path: 'claude/classification-example.json',
      content: JSON.stringify({ holdings: [{ ticker: 'EXUS', style: 'value' }] }),
    },
    {
      path: 'claude/metadata-example.json',
      content: JSON.stringify({ description: 'ETF ledger design discussion only' }),
    },
  ];
  assert.deepEqual(auditEtfLedgerEntries(entries), []);
});

test('git collection scans both tracked files and the complete PR change from the base SHA', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-leak-guard-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'ETF Guard Test']);
  git(directory, ['config', 'user.email', 'guard@example.invalid']);
  fs.writeFileSync(path.join(directory, 'README.md'), 'safe\n');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-qm', 'safe base']);
  const baseSha = git(directory, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(directory, 'cache.txt'), privateLedger);
  git(directory, ['add', 'cache.txt']);
  git(directory, ['commit', '-qm', 'add disguised private ledger']);
  const paths = collectTrackedAndChangedPaths(directory, baseSha);
  assert.deepEqual([...paths.get('cache.txt')].sort(), ['changed', 'tracked']);
  assert.equal(auditGitRepository({ cwd: directory, baseSha }).violations.length, 1);
});

test('repository controls keep ignore, CI, ownership and publication-lock coverage together', () => {
  const ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  const owners = fs.readFileSync(path.join(repo, '.github', 'CODEOWNERS'), 'utf8');
  const scriptsCheck = fs.readFileSync(path.join(repo, '.github', 'workflows', 'scripts-check.yml'), 'utf8');
  const policyLock = fs.readFileSync(path.join(repo, '.github', 'workflows', 'xuan-ib-policy-lock.yml'), 'utf8');
  assert.match(ignore, /\*\*\/\*etf\*ledger\*\.json/);
  assert.match(ignore, /!claude\/xuan-ib-etf-ledger-public-genesis-v1\.json/);
  assert.match(owners, /xuan-ib-etf-ledger-leak-guard/);
  assert.match(owners, /claude\/xuan-ib-etf-ledger-\*\.json/);
  assert.match(scriptsCheck, /xuan-ib-etf-ledger-leak-guard\.mjs/);
  assert.match(scriptsCheck, /xuan-ib-etf-ledger-leak-guard\.test\.mjs/);
  assert.match(policyLock, /xuan-ib-etf-ledger-leak-guard/);
  assert.match(policyLock, /xuan-ib-etf-ledger-\[\^\/\]\+/);
});
