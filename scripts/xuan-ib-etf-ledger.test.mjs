import assert from 'node:assert/strict';
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
const publicGenesisPath = path.join(here, '..', 'claude', 'xuan-ib-etf-ledger-public-genesis-v1.json');
const NOW = new Date('2026-09-03T00:00:00+08:00');
const secret = Buffer.alloc(32, 0x51);
const hash = character => character.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));

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
