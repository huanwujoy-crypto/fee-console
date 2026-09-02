import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ETF_ABC_POLICY_FINGERPRINT } from './xuan-ib-etf-abc.mjs';
import {
  appendEstablishedBaseline,
  canonicalEtfLedgerJson,
  createInitialPrivateEtfLedger,
  deriveBaselineFromEvidence,
  loadPrivateBaselineEvidenceManifest,
  loadPrivateCommitmentSecret,
  loadPrivateEtfLedger,
  loadPrivatePublicEtfLedgerCheckpoint,
  parseCanonicalBaselineEvidenceManifest,
  parseCanonicalPrivateEtfLedger,
  parseCanonicalPublicEtfLedgerCheckpoint,
  projectPublicEtfLedgerCheckpoint,
  serializeCanonicalEtfLedger,
  validateBaselineEvidenceManifest,
  validatePrivateEtfLedger,
  validatePrivateEtfLedgerContinuity,
  validatePublicEtfLedgerCheckpoint,
  verifyPublicEtfLedgerCheckpoint,
} from './xuan-ib-etf-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, 'xuan-ib-etf-ledger.mjs');
const publicGenesisPath = path.join(here, '..', 'claude', 'xuan-ib-etf-ledger-public-genesis-v1.json');
const NOW = new Date('2026-09-03T00:00:00+08:00');
const secret = Buffer.alloc(32, 0x51);
const hash = character => character.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));

const runCli = args => spawnSync(process.execPath, [cliPath, ...args], {
  cwd: path.resolve(here, '..'),
  encoding: 'utf8',
});

const privateRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-bootstrap-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const privatePath = (root, name) => path.join(root, name);

const assertPrivateFile = filePath => {
  const stat = fs.lstatSync(filePath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
};

const evidence = (overrides = {}) => ({
  schemaVersion: 1,
  evidenceId: 'xuan-ib-etf-t0-baseline-evidence-v1',
  methodId: 'xuan-ib-etf-abc-v1',
  t0DateHkt: '2026-09-01',
  currency: 'USD',
  valuationCutoffAtHkt: '2026-09-02T04:00:00+08:00',
  evidenceObservedAtHkt: '2026-09-02T06:00:00+08:00',
  policyFingerprint: ETF_ABC_POLICY_FINGERPRINT,
  scopeFingerprint: hash('b'),
  sourceFingerprint: hash('c'),
  valuationCalendarFingerprint: hash('d'),
  holdings: [
    {
      accountKey: 'IB', holdingId: 'h-001', instrumentId: 'USD-CASH', quantity: '1000.00', unitPriceUsd: '1',
      valuationAsOfHkt: '2026-09-02T04:00:00+08:00',
      sourceFingerprint: hash('e'), valuationEvidenceFingerprint: hash('f'),
    },
    {
      accountKey: 'NOAH', holdingId: 'h-002', instrumentId: 'CSPX:IE00B5BMR087', quantity: '2.5', unitPriceUsd: '100.20',
      valuationAsOfHkt: '2026-09-02T04:00:00+08:00',
      sourceFingerprint: hash('1'), valuationEvidenceFingerprint: hash('2'),
    },
  ],
  ...overrides,
});

test('canonical private evidence exclusively derives A value and an identical B clone', () => {
  const manifest = evidence();
  assert.equal(validateBaselineEvidenceManifest(manifest, { now: NOW }), manifest);
  const derived = deriveBaselineFromEvidence(manifest, { now: NOW });
  assert.equal(derived.valueUsd, 1250.50);
  assert.match(derived.holdingsFingerprint, /^[a-f0-9]{64}$/);

  const pending = createInitialPrivateEtfLedger();
  const established = appendEstablishedBaseline(pending, manifest, { now: NOW });
  const payload = established.records[1].payload;
  assert.equal(payload.aValueUsd, derived.valueUsd);
  assert.equal(payload.bValueUsd, derived.valueUsd);
  assert.equal(payload.aHoldingsFingerprint, derived.holdingsFingerprint);
  assert.equal(payload.bHoldingsFingerprint, derived.holdingsFingerprint);
  assert.deepEqual(payload.evidenceManifest, manifest);
});

test('A is the sum of per-holding half-up USD-cent values, not a rounded aggregate', () => {
  const manifest = evidence({
    holdings: [
      {
        accountKey: 'IB', holdingId: 'h-001', instrumentId: 'ROUNDING-A', quantity: '1', unitPriceUsd: '1.005',
        valuationAsOfHkt: '2026-09-02T04:00:00+08:00',
        sourceFingerprint: hash('e'), valuationEvidenceFingerprint: hash('f'),
      },
      {
        accountKey: 'NOAH', holdingId: 'h-002', instrumentId: 'ROUNDING-B', quantity: '1', unitPriceUsd: '2.005',
        valuationAsOfHkt: '2026-09-02T04:00:00+08:00',
        sourceFingerprint: hash('1'), valuationEvidenceFingerprint: hash('2'),
      },
    ],
  });
  assert.equal(deriveBaselineFromEvidence(manifest, { now: NOW }).valueUsd, 3.02);
});

test('caller-supplied established amounts and identities cannot bypass evidence derivation', () => {
  const pending = createInitialPrivateEtfLedger();
  assert.throws(() => appendEstablishedBaseline(pending, {
    status: 'established', aValueUsd: 999999, bValueUsd: 999999,
  }, { now: NOW }), /evidence manifest/);

  const established = appendEstablishedBaseline(pending, evidence(), { now: NOW });
  const forged = clone(established);
  forged.records[1].payload.aValueUsd += 1;
  assert.throws(() => validatePrivateEtfLedger(forged, { now: NOW }), /hash-chain|code-derived/);
});

test('evidence fails closed on an early cutoff, future observation, wrong policy or incomplete source bindings', () => {
  for (const manifest of [
    evidence({ valuationCutoffAtHkt: '2026-09-02T03:59:59+08:00' }),
    evidence({ valuationCutoffAtHkt: '2026-09-02T04:00:01+08:00' }),
    evidence({ evidenceObservedAtHkt: '2026-09-04T00:00:00+08:00' }),
    evidence({ policyFingerprint: hash('9') }),
    evidence({ scopeFingerprint: null }),
    evidence({ sourceFingerprint: null }),
    evidence({ valuationCalendarFingerprint: null }),
  ]) assert.throws(() => validateBaselineEvidenceManifest(manifest, { now: NOW }), /invalid|cutoff|future/);
});

test('holdings must be sorted, unique, decimal-string exact, source-bound and valuation-bound', () => {
  const base = evidence();
  for (const holdings of [
    [...base.holdings].reverse(),
    [base.holdings[0], { ...base.holdings[1], holdingId: 'h-001' }],
    [{ ...base.holdings[0], quantity: 1 }, base.holdings[1]],
    [{ ...base.holdings[0], quantity: '0' }, base.holdings[1]],
    [{ ...base.holdings[0], unitPriceUsd: '1.000000000' }, base.holdings[1]],
    [{ ...base.holdings[0], accountKey: '' }, base.holdings[1]],
    [{ ...base.holdings[0], valuationAsOfHkt: '2026-08-31T23:59:59+08:00' }, base.holdings[1]],
    [{ ...base.holdings[0], valuationAsOfHkt: '2026-09-02T04:00:01+08:00' }, base.holdings[1]],
    [{ ...base.holdings[0], valuationEvidenceFingerprint: null }, base.holdings[1]],
  ]) assert.throws(() => validateBaselineEvidenceManifest(evidence({ holdings }), { now: NOW }), /holding|decimal|positive/);
});

test('evidence and private ledger files require byte-exact canonical JSON', () => {
  const evidenceJson = serializeCanonicalEtfLedger(evidence());
  assert.deepEqual(parseCanonicalBaselineEvidenceManifest(evidenceJson, { now: NOW }), evidence());
  assert.throws(() => parseCanonicalBaselineEvidenceManifest(`${evidenceJson.trim()} `, { now: NOW }), /canonical/);
  const duplicateKey = evidenceJson.replace('{"currency":"USD"', '{"currency":"USD","currency":"USD"');
  assert.throws(() => parseCanonicalBaselineEvidenceManifest(duplicateKey, { now: NOW }), /canonical/);
  const ledger = createInitialPrivateEtfLedger();
  const ledgerJson = serializeCanonicalEtfLedger(ledger);
  assert.deepEqual(parseCanonicalPrivateEtfLedger(ledgerJson, { now: NOW }), ledger);
  assert.throws(() => parseCanonicalPrivateEtfLedger(JSON.stringify(ledger) + '\n', { now: NOW }), /canonical/);
});

test('private history is an immutable hash-chain prefix', () => {
  const pending = createInitialPrivateEtfLedger();
  const established = appendEstablishedBaseline(pending, evidence(), { now: NOW });
  assert.equal(validatePrivateEtfLedgerContinuity(pending, established, { now: NOW }), established);
  assert.throws(() => validatePrivateEtfLedgerContinuity(established, pending, { now: NOW }), /truncated/);
  const replacement = appendEstablishedBaseline(pending, evidence({ sourceFingerprint: hash('8') }), { now: NOW });
  assert.throws(() => validatePrivateEtfLedgerContinuity(established, replacement, { now: NOW }), /immutable ordered prefix/);
});

test('HMAC commitments hide the raw head and bind each checkpoint to both predecessor chains', () => {
  const pending = createInitialPrivateEtfLedger();
  const first = projectPublicEtfLedgerCheckpoint(pending, { commitmentSecret: secret, now: NOW });
  assert.notEqual(first.privateHeadCommitment, pending.headHash);
  assert.equal(first.commitmentAlgorithm, 'HMAC-SHA256');
  assert.match(first.commitmentKeyId, /^[a-f0-9]{64}$/);
  assert.equal(verifyPublicEtfLedgerCheckpoint(first, {
    commitmentSecret: secret, privateLedger: pending, now: NOW,
  }), first);
  const otherSecret = Buffer.alloc(32, 0x52);
  assert.notEqual(
    projectPublicEtfLedgerCheckpoint(pending, { commitmentSecret: otherSecret, now: NOW }).privateHeadCommitment,
    first.privateHeadCommitment,
  );
  const highByteA = projectPublicEtfLedgerCheckpoint(pending, {
    commitmentSecret: Buffer.alloc(32, 0x80), now: NOW,
  });
  const highByteB = projectPublicEtfLedgerCheckpoint(pending, {
    commitmentSecret: Buffer.alloc(32, 0x81), now: NOW,
  });
  assert.notEqual(highByteA.commitmentKeyId, highByteB.commitmentKeyId);
  assert.notEqual(highByteA.privateHeadCommitment, highByteB.privateHeadCommitment);
  assert.throws(() => verifyPublicEtfLedgerCheckpoint(first, {
    commitmentSecret: otherSecret, privateLedger: pending, now: NOW,
  }), /HMAC/);

  const established = appendEstablishedBaseline(pending, evidence(), { now: NOW });
  const second = projectPublicEtfLedgerCheckpoint(established, {
    commitmentSecret: secret, previousCheckpoint: first, previousPrivateLedger: pending, now: NOW,
  });
  assert.equal(second.previousCheckpointHash, first.checkpointHash);
  assert.equal(second.previousPrivateHeadCommitment, first.privateHeadCommitment);
  assert.equal(second.commitmentKeyId, first.commitmentKeyId);
  assert.equal(verifyPublicEtfLedgerCheckpoint(second, {
    commitmentSecret: secret, privateLedger: established,
    previousCheckpoint: first, previousPrivateLedger: pending, now: NOW,
  }), second);
  assert.throws(() => projectPublicEtfLedgerCheckpoint(established, {
    commitmentSecret: secret, now: NOW,
  }), /continue/);
  assert.throws(() => verifyPublicEtfLedgerCheckpoint({ ...second, previousCheckpointHash: hash('0') }, {
    commitmentSecret: secret, privateLedger: established,
    previousCheckpoint: first, previousPrivateLedger: pending, now: NOW,
  }), /HMAC|continue/);
});

test('public state is value-free and private field injection is rejected', () => {
  const checkpoint = projectPublicEtfLedgerCheckpoint(createInitialPrivateEtfLedger(), {
    commitmentSecret: secret, now: NOW,
  });
  const text = canonicalEtfLedgerJson(checkpoint);
  assert.doesNotMatch(text, /records|payload|ValueUsd|Holdings|cash|flow|price|position|units|NAV/i);
  for (const [key, value] of [['records', []], ['aValueUsd', 1], ['holdings', []], ['prices', {}]]) {
    assert.throws(() => validatePublicEtfLedgerCheckpoint({ ...checkpoint, [key]: value }), /private field/);
  }
  assert.throws(() => projectPublicEtfLedgerCheckpoint(createInitialPrivateEtfLedger(), {
    commitmentSecret: Buffer.alloc(31), now: NOW,
  }), /at least 32/);
});

test('committed public genesis is canonical, pending and contains only checkpoint fields', () => {
  const bytes = fs.readFileSync(publicGenesisPath, 'utf8');
  const checkpoint = parseCanonicalPublicEtfLedgerCheckpoint(bytes);
  assert.equal(checkpoint.baselineStatus, 'pending');
  assert.equal(checkpoint.entryCount, 1);
  assert.equal(bytes, serializeCanonicalEtfLedger(checkpoint));
  assert.doesNotMatch(bytes, /records|payload|ValueUsd|Holdings|cash|flow|price|position|units|NAV/i);
});

test('private loaders enforce approved root, owner-only root, regular current-user 0600 files and environment routing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-approved-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-outside-'));
  fs.chmodSync(root, 0o700);
  fs.chmodSync(outside, 0o700);
  t.after(() => {
    delete process.env.XUAN_ETF_PRIVATE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const ledgerPath = path.join(root, 'ledger.json');
  const evidencePath = path.join(root, 'evidence.json');
  const secretPath = path.join(root, 'commitment.key');
  fs.writeFileSync(ledgerPath, serializeCanonicalEtfLedger(createInitialPrivateEtfLedger()), { mode: 0o600 });
  fs.writeFileSync(evidencePath, serializeCanonicalEtfLedger(evidence()), { mode: 0o600 });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  assert.equal(loadPrivateEtfLedger(ledgerPath, { approvedRoot: root, now: NOW }).baselineStatus, 'pending');
  assert.equal(loadPrivateBaselineEvidenceManifest(evidencePath, { approvedRoot: root, now: NOW }).holdings.length, 2);
  assert.deepEqual(loadPrivateCommitmentSecret(secretPath, { approvedRoot: root }), secret);

  process.env.XUAN_ETF_PRIVATE_ROOT = root;
  assert.equal(loadPrivateEtfLedger(ledgerPath, { now: NOW }).baselineStatus, 'pending');
  const outsidePath = path.join(outside, 'ledger.json');
  fs.writeFileSync(outsidePath, serializeCanonicalEtfLedger(createInitialPrivateEtfLedger()), { mode: 0o600 });
  assert.throws(() => loadPrivateEtfLedger(outsidePath, { approvedRoot: root, now: NOW }), /approved private root/);

  fs.chmodSync(ledgerPath, 0o644);
  assert.throws(() => loadPrivateEtfLedger(ledgerPath, { approvedRoot: root, now: NOW }), /0600/);
  fs.chmodSync(ledgerPath, 0o600);
  const linkPath = path.join(root, 'ledger-link.json');
  fs.symlinkSync(ledgerPath, linkPath);
  assert.throws(() => loadPrivateEtfLedger(linkPath, { approvedRoot: root, now: NOW }), /regular/);
  assert.throws(() => loadPrivateEtfLedger(root, { approvedRoot: root, now: NOW }), /regular|direct child/);
  const hardlinkPath = path.join(root, 'ledger-hardlink.json');
  fs.linkSync(ledgerPath, hardlinkPath);
  assert.throws(() => loadPrivateEtfLedger(ledgerPath, { approvedRoot: root, now: NOW }), /single-link/);
  fs.unlinkSync(hardlinkPath);
  const oversizedPath = path.join(root, 'oversized.json');
  fs.writeFileSync(oversizedPath, Buffer.alloc(4 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => loadPrivateEtfLedger(oversizedPath, { approvedRoot: root, now: NOW }), /size limit/);
  const rootLink = `${root}-link`;
  fs.symlinkSync(root, rootLink);
  t.after(() => fs.rmSync(rootLink, { force: true }));
  assert.throws(() => loadPrivateEtfLedger(ledgerPath, { approvedRoot: rootLink, now: NOW }), /symbolic link/);
  fs.chmodSync(root, 0o755);
  assert.throws(() => loadPrivateEtfLedger(ledgerPath, { approvedRoot: root, now: NOW }), /owner-only/);

  const repositoryRoot = path.resolve(here, '..');
  const insidePublicRepo = fs.mkdtempSync(path.join(repositoryRoot, '.etf-private-root-test-'));
  fs.chmodSync(insidePublicRepo, 0o700);
  t.after(() => fs.rmSync(insidePublicRepo, { recursive: true, force: true }));
  const insideLedger = path.join(insidePublicRepo, 'ledger.json');
  fs.writeFileSync(insideLedger, serializeCanonicalEtfLedger(createInitialPrivateEtfLedger()), { mode: 0o600 });
  assert.throws(() => loadPrivateEtfLedger(insideLedger, {
    approvedRoot: insidePublicRepo, now: NOW,
  }), /external/);
});

test('bootstrap CLI initializes a private pending chain and readiness proves it without leaking the secret', t => {
  const root = privateRoot(t);
  const ledger = privatePath(root, 'pending-ledger.json');
  const secretPath = privatePath(root, 'commitment.key');
  const checkpoint = privatePath(root, 'pending-checkpoint.json');
  const result = runCli([
    'init', '--private-root', root, '--ledger-out', ledger,
    '--secret-out', secretPath, '--checkpoint-out', checkpoint,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'ok init baseline=pending entries=1\n');
  for (const filePath of [ledger, secretPath, checkpoint]) assertPrivateFile(filePath);
  assert.equal(fs.readFileSync(secretPath).byteLength, 32);

  const pending = loadPrivateEtfLedger(ledger, { approvedRoot: root, now: NOW });
  const publicState = loadPrivatePublicEtfLedgerCheckpoint(checkpoint, { approvedRoot: root });
  const secretBytes = loadPrivateCommitmentSecret(secretPath, { approvedRoot: root });
  assert.equal(verifyPublicEtfLedgerCheckpoint(publicState, {
    commitmentSecret: secretBytes, privateLedger: pending, now: NOW,
  }), publicState);
  const secretHex = secretBytes.toString('hex');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secretHex));

  const ready = runCli([
    'readiness', '--private-root', root, '--ledger', ledger,
    '--secret', secretPath, '--checkpoint', checkpoint,
  ]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stdout, 'ok readiness baseline=pending entries=1 checkpoint=verified manifest=absent\n');
  assert.doesNotMatch(ready.stdout + ready.stderr, new RegExp(secretHex));
});

test('bootstrap CLI establishes only from canonical synthetic evidence and verifies the successor checkpoint', t => {
  const root = privateRoot(t);
  const pendingLedger = privatePath(root, 'pending-ledger.json');
  const secretPath = privatePath(root, 'commitment.key');
  const pendingCheckpoint = privatePath(root, 'pending-checkpoint.json');
  const manifestPath = privatePath(root, 'synthetic-evidence.json');
  const establishedLedger = privatePath(root, 'established-ledger.json');
  const establishedCheckpoint = privatePath(root, 'established-checkpoint.json');
  assert.equal(runCli([
    'init', '--private-root', root, '--ledger-out', pendingLedger,
    '--secret-out', secretPath, '--checkpoint-out', pendingCheckpoint,
  ]).status, 0);
  const manifest = evidence({ evidenceObservedAtHkt: '2026-09-02T04:00:00+08:00' });
  fs.writeFileSync(manifestPath, serializeCanonicalEtfLedger(manifest), { mode: 0o600 });

  const pendingReady = runCli([
    'readiness', '--private-root', root, '--ledger', pendingLedger,
    '--secret', secretPath, '--checkpoint', pendingCheckpoint, '--manifest', manifestPath,
  ]);
  assert.equal(pendingReady.status, 0, pendingReady.stderr);
  assert.match(pendingReady.stdout, /^ok readiness baseline=pending entries=1 checkpoint=verified manifest=valid holdings=2 fingerprint=[a-f0-9]{64}\n$/);
  const reviewedFingerprint = pendingReady.stdout.match(/fingerprint=([a-f0-9]{64})/)?.[1];
  assert.match(reviewedFingerprint, /^[a-f0-9]{64}$/);

  fs.writeFileSync(manifestPath, serializeCanonicalEtfLedger(evidence({
    evidenceObservedAtHkt: '2026-09-02T04:00:00+08:00',
    sourceFingerprint: hash('8'),
  })), { mode: 0o600 });
  const changedAfterReview = runCli([
    'establish-from-manifest', '--private-root', root, '--ledger-in', pendingLedger,
    '--manifest', manifestPath, '--expected-manifest-fingerprint', reviewedFingerprint,
    '--ledger-out', establishedLedger,
  ]);
  assert.notEqual(changedAfterReview.status, 0);
  assert.match(changedAfterReview.stderr, /changed after readiness|expected fingerprint/);
  assert.equal(fs.existsSync(establishedLedger), false);
  fs.writeFileSync(manifestPath, serializeCanonicalEtfLedger(manifest), { mode: 0o600 });

  const establish = runCli([
    'establish-from-manifest', '--private-root', root, '--ledger-in', pendingLedger,
    '--manifest', manifestPath, '--expected-manifest-fingerprint', reviewedFingerprint,
    '--ledger-out', establishedLedger,
  ]);
  assert.equal(establish.status, 0, establish.stderr);
  assert.match(establish.stdout, /^ok establish baseline=established entries=2 holdings=2 fingerprint=[a-f0-9]{64}\n$/);
  assert.doesNotMatch(establish.stdout + establish.stderr, /1250(?:\.5|\.50)?/);
  assertPrivateFile(establishedLedger);

  const checkpoint = runCli([
    'checkpoint', '--private-root', root, '--secret', secretPath,
    '--previous-ledger', pendingLedger, '--previous-checkpoint', pendingCheckpoint,
    '--ledger', establishedLedger, '--checkpoint-out', establishedCheckpoint,
  ]);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.equal(checkpoint.stdout, 'ok checkpoint baseline=established entries=2\n');
  assertPrivateFile(establishedCheckpoint);
  assert.doesNotMatch(fs.readFileSync(establishedCheckpoint, 'utf8'), /1250|records|payload|holdings/i);

  const establishedReady = runCli([
    'readiness', '--private-root', root, '--ledger', establishedLedger,
    '--secret', secretPath, '--checkpoint', establishedCheckpoint,
    '--previous-ledger', pendingLedger, '--previous-checkpoint', pendingCheckpoint,
    '--manifest', manifestPath,
  ]);
  assert.equal(establishedReady.status, 0, establishedReady.stderr);
  assert.match(establishedReady.stdout, /^ok readiness baseline=established entries=2 checkpoint=verified manifest=valid holdings=2 fingerprint=[a-f0-9]{64}\n$/);
  assert.doesNotMatch(establishedReady.stdout + establishedReady.stderr, /1250(?:\.5|\.50)?/);
});

test('bootstrap CLI is no-clobber and failed preflight leaves no partial bundle', t => {
  const root = privateRoot(t);
  const ledger = privatePath(root, 'pending-ledger.json');
  const secretPath = privatePath(root, 'commitment.key');
  const checkpoint = privatePath(root, 'blocked-checkpoint.json');
  fs.writeFileSync(checkpoint, 'already-here', { mode: 0o600 });
  const before = fs.readFileSync(checkpoint, 'utf8');
  const blocked = runCli([
    'init', '--private-root', root, '--ledger-out', ledger,
    '--secret-out', secretPath, '--checkpoint-out', checkpoint,
  ]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already exists|overwrite/);
  assert.equal(fs.existsSync(ledger), false);
  assert.equal(fs.existsSync(secretPath), false);
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), before);

  const duplicate = runCli([
    'init', '--private-root', root, '--ledger-out', ledger,
    '--secret-out', ledger, '--checkpoint-out', privatePath(root, 'other-checkpoint.json'),
  ]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /distinct/);
  assert.equal(fs.existsSync(ledger), false);
});

test('bootstrap CLI rejects wrong HMAC, incomplete predecessor pairs, unsafe roots and unknown options', t => {
  const root = privateRoot(t);
  const ledger = privatePath(root, 'pending-ledger.json');
  const secretPath = privatePath(root, 'commitment.key');
  const checkpoint = privatePath(root, 'pending-checkpoint.json');
  assert.equal(runCli([
    'init', '--private-root', root, '--ledger-out', ledger,
    '--secret-out', secretPath, '--checkpoint-out', checkpoint,
  ]).status, 0);
  const wrongSecret = privatePath(root, 'wrong.key');
  fs.writeFileSync(wrongSecret, Buffer.alloc(32, 0x7f), { mode: 0o600 });
  const wrong = runCli([
    'readiness', '--private-root', root, '--ledger', ledger,
    '--secret', wrongSecret, '--checkpoint', checkpoint,
  ]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /HMAC/);

  const pair = runCli([
    'readiness', '--private-root', root, '--ledger', ledger,
    '--secret', secretPath, '--checkpoint', checkpoint, '--previous-ledger', ledger,
  ]);
  assert.notEqual(pair.status, 0);
  assert.match(pair.stderr, /both previous/);

  const noOpCheckpoint = privatePath(root, 'no-op-checkpoint.json');
  const noOp = runCli([
    'checkpoint', '--private-root', root, '--secret', secretPath,
    '--previous-ledger', ledger, '--previous-checkpoint', checkpoint,
    '--ledger', ledger, '--checkpoint-out', noOpCheckpoint,
  ]);
  assert.notEqual(noOp.status, 0);
  assert.match(noOp.stderr, /pending-to-established/);
  assert.equal(fs.existsSync(noOpCheckpoint), false);

  const unsafe = runCli([
    'init', '--private-root', path.resolve(here, '..'),
    '--ledger-out', path.resolve(here, '..', '.never-ledger.json'),
    '--secret-out', path.resolve(here, '..', '.never-secret.key'),
    '--checkpoint-out', path.resolve(here, '..', '.never-checkpoint.json'),
  ]);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /external|owner-only/);
  for (const name of ['.never-ledger.json', '.never-secret.key', '.never-checkpoint.json']) {
    assert.equal(fs.existsSync(path.resolve(here, '..', name)), false);
  }

  const unknown = runCli(['init', '--private-root', root, '--unknown', 'value']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown|Missing/);
});
