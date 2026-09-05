import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  finishJournalStage,
  initRunJournal,
  startJournalStage
} from './xuan-ib-run-clock.mjs';
import {
  MANUAL_CONSENT_WINDOW_MS,
  consumeManualConsent,
  getManualConsentRunId,
  issueManualConsent,
  validateManualConsentProof
} from './xuan-ib-manual-consent.mjs';

const EPOCH = Date.parse('2026-09-05T03:00:00.000Z');
const PREVIOUS = 'a'.repeat(40);
const EVIDENCE = 'e'.repeat(64);
const at = (wallMs, monotonicMs = wallMs - EPOCH) => ({
  wallNow: () => wallMs,
  monotonicNowMs: () => monotonicMs
});

const workspace = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-manual-consent-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'run.jsonl');
  initRunJournal(journalPath, at(EPOCH, 0));
  startJournalStage(journalPath, 'bootstrap', at(EPOCH + 100, 100));
  finishJournalStage(journalPath, 'bootstrap', {}, at(EPOCH + 200, 200));
  return { root, journalPath, storePath: path.join(root, 'private', 'consent.jsonl') };
};

const observation = (observedAt = EPOCH + 1_000) => ({
  accountId: 'U6859001',
  provider: 'Anthropic',
  consentRowObserved: true,
  singleConsentRow: true,
  claudeEnabled: true,
  otherAiDisabled: true,
  humanAttested: true,
  attester: 'owner-approved-operator',
  observedAt: new Date(observedAt).toISOString()
});

const issue = (files, overrides = {}) => issueManualConsent({
  observation: observation(),
  journalPath: files.journalPath,
  previousSourceSha: PREVIOUS,
  storePath: files.storePath,
  now: EPOCH + 2_000,
  ...overrides
});

const finishIbRead = (journalPath, start = EPOCH + 3_000, end = EPOCH + 4_000) => {
  startJournalStage(journalPath, 'ib-read', at(start, start - EPOCH));
  finishJournalStage(journalPath, 'ib-read', {}, at(end, end - EPOCH));
};

test('issues a sanitized one-run proof, stores private scope at 0600, and burns on consume', t => {
  const files = workspace(t);
  const proof = issue(files);
  assert.equal(proof.runId, getManualConsentRunId(files.journalPath));
  assert.equal(proof.edition, 'adhoc');
  assert.deepEqual(Object.keys(proof).sort(), [
    'schemaVersion', 'kind', 'runId', 'edition', 'previousSourceSha',
    'observedAt', 'issuedAt', 'expiresAt', 'observationFingerprint', 'proofId'
  ].sort());
  assert.equal(JSON.stringify(proof).includes('U6859001'), false);
  assert.equal(fs.statSync(path.dirname(files.storePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(files.storePath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(files.storePath, 'utf8'), /U6859001/);

  finishIbRead(files.journalPath);
  const consumed = consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 5_000
  });
  assert.equal(consumed.consumedAt, '2026-09-05T03:00:05.000Z');
  assert.deepEqual(consumed.proof, proof);
  assert.match(fs.readFileSync(files.storePath, 'utf8'), new RegExp(EVIDENCE));
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 6_000
  }), /already been consumed/);
});

test('rejects issue replay globally within the same store, including a different run', t => {
  const files = workspace(t);
  issue(files);
  assert.throws(() => issue(files), /already been issued/);

  const otherJournal = path.join(files.root, 'other-run.jsonl');
  initRunJournal(otherJournal, at(EPOCH + 500, 0));
  startJournalStage(otherJournal, 'bootstrap', at(EPOCH + 600, 100));
  finishJournalStage(otherJournal, 'bootstrap', {}, at(EPOCH + 700, 200));
  assert.throws(() => issue(files, { journalPath: otherJournal }), /already been issued/);
});

test('uses a half-open 20-minute window and rejects future or out-of-journal observations', t => {
  const exact = workspace(t);
  assert.throws(() => issue(exact, {
    now: EPOCH + 1_000 + MANUAL_CONSENT_WINDOW_MS
  }), /expired/);

  const future = workspace(t);
  assert.throws(() => issue(future, {
    observation: observation(EPOCH + 3_000), now: EPOCH + 2_000
  }), /future/);

  const outside = workspace(t);
  assert.throws(() => issue(outside, {
    observation: observation(EPOCH - 1)
  }), /outside the run journal/);

  const invalidDate = workspace(t);
  assert.throws(() => issue(invalidDate, {
    observation: { ...observation(), observedAt: '2026-09-05T03:00:01Z' }
  }), /canonical UTC instant/);
});

test('issue requires one completed ok bootstrap and no financial or later stage activity', t => {
  const noBootstrap = workspace(t);
  const freshJournal = path.join(noBootstrap.root, 'fresh.jsonl');
  initRunJournal(freshJournal, at(EPOCH, 0));
  assert.throws(() => issue(noBootstrap, { journalPath: freshJournal }), /completed ok bootstrap/);

  const failed = workspace(t);
  const failedJournal = path.join(failed.root, 'failed.jsonl');
  initRunJournal(failedJournal, at(EPOCH, 0));
  startJournalStage(failedJournal, 'bootstrap', at(EPOCH + 100, 100));
  finishJournalStage(failedJournal, 'bootstrap', {
    status: 'failed', errorCode: 'BOOTSTRAP_FAILED'
  }, at(EPOCH + 200, 200));
  assert.throws(() => issue(failed, { journalPath: failedJournal }), /completed ok bootstrap/);

  for (const stage of ['ib-read', 'sharesight-read', 'render']) {
    const files = workspace(t);
    startJournalStage(files.journalPath, stage, at(EPOCH + 300, 300));
    assert.throws(() => issue(files), /before any other stage starts/);
  }
});

test('pure validation requires explicit context and binds run, prior SHA and adhoc edition', t => {
  const files = workspace(t), proof = issue(files), runId = getManualConsentRunId(files.journalPath);
  assert.deepEqual(validateManualConsentProof(proof, {
    journalRunId: runId, previousSourceSha: PREVIOUS, edition: 'adhoc', requireUnexpired: false
  }), proof);
  assert.throws(() => validateManualConsentProof(proof, {
    journalRunId: runId, previousSourceSha: PREVIOUS, requireUnexpired: false
  }), /missing edition/);
  assert.throws(() => validateManualConsentProof(proof, {
    journalRunId: 'b'.repeat(64), previousSourceSha: PREVIOUS,
    edition: 'adhoc', requireUnexpired: false
  }), /different run/);
  assert.throws(() => validateManualConsentProof(proof, {
    journalRunId: runId, previousSourceSha: 'b'.repeat(40),
    edition: 'adhoc', requireUnexpired: false
  }), /previousSourceSha/);
  assert.throws(() => validateManualConsentProof(proof, {
    journalRunId: runId, previousSourceSha: PREVIOUS,
    edition: 'pm', requireUnexpired: false
  }), /edition must be adhoc/);
  assert.throws(() => validateManualConsentProof(proof, {
    journalRunId: runId, previousSourceSha: PREVIOUS,
    edition: 'adhoc', requireUnexpired: true
  }), /now is required/);
});

test('rejects malformed proofs and expiry at the exact consume boundary', t => {
  const files = workspace(t), proof = issue(files), runId = getManualConsentRunId(files.journalPath);
  const context = {
    journalRunId: runId, previousSourceSha: PREVIOUS,
    edition: 'adhoc', requireUnexpired: false
  };
  assert.throws(() => validateManualConsentProof({ ...proof, extra: true }, context), /unknown field extra/);
  assert.throws(() => validateManualConsentProof({ ...proof, proofId: 'b'.repeat(64) }, context), /proofId/);
  assert.throws(() => validateManualConsentProof({ ...proof, observedAt: '2026-09-05T03:00:01Z' }, context), /canonical UTC/);

  finishIbRead(files.journalPath);
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath, sourceEvidenceFingerprint: EVIDENCE,
    now: EPOCH + 1_000 + MANUAL_CONSENT_WINDOW_MS
  }), /expired/);
});

test('consume rejects a different run, different prior SHA, early use and use after render starts', t => {
  const files = workspace(t), proof = issue(files);
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: 'BAD', now: EPOCH + 2_500
  }), /sourceEvidenceFingerprint/);
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 2_500
  }), /before ib-read finishes/);

  const otherJournal = path.join(files.root, 'other.jsonl');
  initRunJournal(otherJournal, at(EPOCH + 500, 0));
  startJournalStage(otherJournal, 'bootstrap', at(EPOCH + 600, 100));
  finishJournalStage(otherJournal, 'bootstrap', {}, at(EPOCH + 700, 200));
  finishIbRead(otherJournal, EPOCH + 3_000, EPOCH + 4_000);
  assert.throws(() => consumeManualConsent({
    proof, journalPath: otherJournal, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 5_000
  }), /different run/);

  finishIbRead(files.journalPath);
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: 'b'.repeat(40),
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 5_000
  }), /previousSourceSha/);
  startJournalStage(files.journalPath, 'render', at(EPOCH + 5_500, 5_500));
  assert.throws(() => consumeManualConsent({
    proof, journalPath: files.journalPath, previousSourceSha: PREVIOUS,
    edition: 'adhoc', storePath: files.storePath,
    sourceEvidenceFingerprint: EVIDENCE, now: EPOCH + 6_000
  }), /before render/);
});

test('rejects symlink journal and store paths and extra private observation material', t => {
  const files = workspace(t);
  const journalLink = path.join(files.root, 'journal-link');
  fs.symlinkSync(files.journalPath, journalLink);
  assert.throws(() => issue(files, { journalPath: journalLink }), /non-symlink/);
  assert.throws(() => issue(files, {
    observation: { ...observation(), contact: 'not accepted' }
  }), /unknown field contact/);
  assert.throws(() => issue(files, {
    observation: { ...observation(), singleConsentRow: false }
  }), /singleConsentRow must be explicitly true/);
  assert.throws(() => issue(files, {
    observation: { ...observation(), attester: 'Wu' }
  }), /attester is invalid/);

  const privateDir = path.join(files.root, 'private');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const target = path.join(privateDir, 'target.jsonl');
  fs.writeFileSync(target, '{}\n', { mode: 0o600 });
  const storeLink = path.join(privateDir, 'store-link.jsonl');
  fs.symlinkSync(target, storeLink);
  assert.throws(() => issue(files, {
    observation: observation(EPOCH + 1_001), storePath: storeLink
  }), /non-symlink/);
});

test('two independent processes cannot both reserve the same observation', async t => {
  const files = workspace(t);
  const moduleUrl = new URL('./xuan-ib-manual-consent.mjs', import.meta.url).href;
  const input = {
    observation: observation(),
    journalPath: files.journalPath,
    previousSourceSha: PREVIOUS,
    storePath: files.storePath,
    now: EPOCH + 2_000
  };
  const program = `
    import { issueManualConsent } from ${JSON.stringify(moduleUrl)};
    try {
      const proof = issueManualConsent(JSON.parse(process.argv[1]));
      process.stdout.write(JSON.stringify({ ok: true, proofId: proof.proofId }));
    } catch (error) {
      process.stderr.write(String(error.message));
      process.exitCode = 1;
    }
  `;
  const launch = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program, JSON.stringify(input)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([launch(), launch()]);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.code !== 0).length, 1, JSON.stringify(results));
  assert.match(results.find(result => result.code !== 0).stderr,
    /private store is locked|already been issued|directory cannot be created/);
  const records = fs.readFileSync(files.storePath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(records.filter(record => record.type === 'reserve').length, 1);
});
