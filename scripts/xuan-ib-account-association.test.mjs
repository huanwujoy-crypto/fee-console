import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ASSOCIATION_BASIS, ASSOCIATION_DISCLOSURE_ID, ASSOCIATION_POLICY_PATH,
  MAX_ASSOCIATION_WINDOW_MS, MAX_POLICY_LOOKUP_AGE_MS,
  associationPolicyText, associationPolicyBlob, validateAssociationSnapshot,
  createAssociationReceipt, createPreReadAssociationReceipt,
  extractAssociationReceipt, loadTrustedAssociationPolicy,
  renderAssociationDisclosure, renderAssociationReceipt,
  validateAssociationPolicy, validateAssociationReceipt,
  validateAssociationReceiptShape, validatePublicationAssociation
} from './xuan-ib-account-association.mjs';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { inactiveAssociationPolicy, inactiveAssociationSnapshot } from './xuan-ib-association-test-fixture.mjs';

const NOW = Date.parse('2026-09-05T06:00:00.000Z');
const SHA = 'a'.repeat(40), RUN = 'c'.repeat(64), PRIOR = 'd'.repeat(40);
const iso = ms => new Date(ms).toISOString();
const policy = (changes = {}) => ({
  schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
  basis: ASSOCIATION_BASIS, status: 'active', purpose: 'xuan-ib-read-only-report',
  editions: ['adhoc'], publisher: 'claude-verified-candidate-v1',
  validFrom: iso(NOW - 1000), expiresAt: iso(NOW - 1000 + MAX_ASSOCIATION_WINDOW_MS), ...changes
});
const snapshot = (changes = {}) => ({ policy: policy(), policyCommit: SHA, policyBlob: associationPolicyBlob(changes.policy ?? policy()), checkedAt: iso(NOW), ...changes });
const context = (changes = {}) => ({ now: NOW, edition: 'adhoc', previousSourceSha: PRIOR, runId: RUN, ...changes });
const receipt = () => createAssociationReceipt(snapshot(), context());

test('checked-in deployment policy is canonical, bounded and contains no private identity', () => {
  const file = new URL(`../${ASSOCIATION_POLICY_PATH}`, import.meta.url);
  const text = fs.readFileSync(file, 'utf8'), value = JSON.parse(text);
  assert.equal(text, associationPolicyText(value));
  // Deployment-state validation must remain valid after activation or expiry;
  // runtime authorization and the inactive defaults are tested separately.
  assert.deepEqual(validateAssociationPolicy(value, { now: NOW, requireActive: false }), value);
  if (value.status === 'inactive') {
    assert.equal(value.validFrom, null);
    assert.equal(value.expiresAt, null);
  } else {
    const duration = Date.parse(value.expiresAt) - Date.parse(value.validFrom);
    assert.ok(duration > 0 && duration <= MAX_ASSOCIATION_WINDOW_MS);
  }
  assert.doesNotMatch(text, /accountId|token|username|consentRow|observedAt|U\d{6,}/i);
});

test('fixed synthetic inactive policy has no timer and cannot authorize a run', () => {
  const value = inactiveAssociationPolicy(), current = inactiveAssociationSnapshot(NOW);
  assert.equal(value.status, 'inactive');
  assert.equal(value.validFrom, null);
  assert.equal(value.expiresAt, null);
  assert.deepEqual(current.policy, value);
  assert.equal(current.policyBlob, associationPolicyBlob(value));
  assert.deepEqual(validateAssociationPolicy(value, { now: NOW, requireActive: false }), value);
  assert.throws(() => validateAssociationPolicy(value, { now: NOW }), /inactive/);
  assert.throws(() => validateAssociationSnapshot(current, { now: NOW }), /inactive/);
});

test('active or revoked deployment-file reads cannot alter the fixed inactive fixture', t => {
  const file = new URL(`../${ASSOCIATION_POLICY_PATH}`, import.meta.url);
  const originalRead = fs.readFileSync;
  const unchangedDeploymentBytes = originalRead(file, 'utf8');
  for (const status of ['active', 'revoked']) {
    const deployment = policy({ status });
    const fakeRead = t.mock.method(fs, 'readFileSync', function (input, ...args) {
      if (String(input) === String(file)) return associationPolicyText(deployment);
      return originalRead.call(this, input, ...args);
    });
    try {
      assert.deepEqual(validateAssociationPolicy(JSON.parse(fs.readFileSync(file, 'utf8')),
        { now: NOW, requireActive: false }), deployment);
      const current = inactiveAssociationSnapshot(NOW);
      assert.deepEqual(current.policy, inactiveAssociationPolicy());
      assert.equal(current.policy.status, 'inactive');
      assert.equal(current.policy.validFrom, null);
      assert.equal(current.policy.expiresAt, null);
      assert.equal(current.policyBlob, associationPolicyBlob(current.policy));
      assert.equal(fakeRead.mock.callCount(), 1, 'the fixture must not read the deployment file');
      current.policy.editions.push('pm');
      assert.deepEqual(inactiveAssociationSnapshot(NOW).policy.editions, ['adhoc']);
    } finally {
      fakeRead.mock.restore();
    }
  }
  assert.equal(originalRead(file, 'utf8'), unchangedDeploymentBytes, 'no deployment policy was written');
});

test('only exact bounded schema, alias, purpose, publisher, basis and adhoc scope accepted', () => {
  assert.deepEqual(validateAssociationPolicy(policy(), context()), policy());
  const cases = [
    { accountId: 'private-account' }, { schemaVersion: 2 }, { accountAlias: 'Other' },
    { basis: 'manual-consent-once-v1' }, { policyId: 'unreviewed' },
    { purpose: 'trading' }, { publisher: 'other' }, { editions: ['adhoc', 'pm'] },
    { editions: [] }, { editions: ['adhoc', 'adhoc'] }, { status: 'enabled' }
  ];
  for (const change of cases) assert.throws(() => validateAssociationPolicy(policy(change), context()));
  assert.throws(() => validateAssociationPolicy({ ...policy(), token: 'never-accepted' }, context()), /allowlisted/);
  assert.throws(() => validateAssociationPolicy(policy(), { ...context(), edition: 'pm' }), /scope/);
  assert.throws(() => validateAssociationPolicy(policy(), { ...context(), publisher: 'other' }), /scope/);
  assert.throws(() => validateAssociationPolicy(policy(), { ...context(), purpose: 'other' }), /scope/);
  assert.throws(() => validateAssociationPolicy(policy(), { ...context(), now: NaN }), /epoch/);
});

test('future, expired, revoked, inactive and over-seven-day policy cannot authorize', () => {
  assert.throws(() => validateAssociationPolicy(policy({ validFrom: iso(NOW + 1) }), context()), /not yet valid/);
  assert.throws(() => validateAssociationPolicy(policy({ expiresAt: iso(NOW) }), context()), /expired/);
  assert.throws(() => validateAssociationPolicy(policy({ status: 'revoked' }), context()), /revoked/);
  assert.throws(() => validateAssociationPolicy(policy({ expiresAt: iso(NOW + MAX_ASSOCIATION_WINDOW_MS) }), context()), /seven days/);
  assert.throws(() => validateAssociationPolicy(policy({ expiresAt: policy().validFrom }), context()), /positive/);
  assert.throws(() => validateAssociationPolicy(policy({ validFrom: '2026-09-05T05:59:59Z' }), context()), /canonical UTC/);
  assert.throws(() => validateAssociationPolicy(policy({ status: 'inactive' }), { ...context(), requireActive: false }), /must not start/);
  assert.equal(validateAssociationPolicy(policy({ expiresAt: iso(NOW) }), { ...context(), requireActive: false }).status, 'active');
});

test('receipt binds run, prior report, policy blob and checked time but allows unrelated main commits', () => {
  const saved = receipt();
  assert.deepEqual(validateAssociationReceipt(saved, snapshot({ policyCommit: 'e'.repeat(40) }), context()), saved);
  for (const change of [{ runId: 'f'.repeat(64) }, { previousSourceSha: 'f'.repeat(40) }, { edition: 'pm' }]) {
    assert.throws(() => validateAssociationReceipt(saved, snapshot(), context(change)));
  }
  assert.throws(() => validateAssociationReceipt(saved, snapshot({ policyBlob: 'f'.repeat(40) }), context()), /changed/);
  assert.throws(() => validateAssociationReceipt({ ...saved, policyCheckedAt: iso(NOW + 1) }, snapshot(), context()), /after current lookup|outside policy/);
  assert.throws(() => validateAssociationReceipt({ ...saved, policyCheckedAt: iso(NOW - 2000) }, snapshot(), context()), /outside policy/);
  assert.throws(() => validateAssociationReceipt({ ...saved, token: 'not-public' }, snapshot(), context()), /allowlisted/);
  assert.throws(() => validateAssociationReceipt({ ...saved, policyBlob: 'B'.repeat(40) }, snapshot(), context()), /invalid/);
  assert.throws(() => validateAssociationReceipt({ ...saved, runId: 'c'.repeat(40) }, snapshot(), context()), /invalid/);
  assert.throws(() => validateAssociationReceiptShape(saved, { preparedAt: iso(NOW - 1) }), /after report preparation/);
  assert.throws(() => validateAssociationReceiptShape(saved, { previousSourceSha: 'e'.repeat(40) }), /does not bind/);
});

test('cached or future snapshot fails; old receipt only works while newly fetched unchanged policy remains active', () => {
  const saved = receipt();
  assert.throws(() => validateAssociationReceipt(saved, snapshot({ checkedAt: iso(NOW - MAX_POLICY_LOOKUP_AGE_MS - 1) }), context()), /stale/);
  assert.throws(() => validateAssociationReceipt(saved, snapshot({ checkedAt: iso(NOW + 1) }), context()), /future/);
  const later = NOW + 100_000;
  assert.deepEqual(validateAssociationReceipt(saved, snapshot({ checkedAt: iso(later) }), context({ now: later })), saved);
  assert.throws(() => validateAssociationReceipt(saved, snapshot({ policy: policy({ status: 'revoked' }) }), context()), /revoked/);
  const end = Date.parse(policy().expiresAt);
  assert.throws(() => validateAssociationReceipt(saved, snapshot({ checkedAt: iso(end) }), context({ now: end })), /expired/);
});

test('canonical receipt roundtrip rejects duplicate markers, changed encoding and inert hiding', () => {
  const saved = receipt(), html = renderAssociationReceipt(saved);
  assert.deepEqual(extractAssociationReceipt(html), saved);
  assert.equal(extractAssociationReceipt('<html></html>'), null);
  assert.throws(() => extractAssociationReceipt(html + html), /exactly one/);
  assert.throws(() => extractAssociationReceipt(html.replace('>{', '> {')), /canonical/);
  assert.throws(() => extractAssociationReceipt(html.replace('"runId"', '"notRunId"')), /allowlisted/);
  assert.throws(() => extractAssociationReceipt(`<!--${html}-->`), /comment/);
  assert.throws(() => extractAssociationReceipt(`<template>${html}</template>`), /inert/);
  assert.throws(() => extractAssociationReceipt(`<script>${html}</script>`), /inert/);
  assert.throws(() => extractAssociationReceipt(html.replace('id="', "id='")), /canonical/);
});

test('publication requires exact public disclosure, avoids raw identity and rejects hidden or duplicate disclosure', () => {
  const saved = receipt(), mark = renderAssociationReceipt(saved), disclosure = renderAssociationDisclosure(saved, snapshot());
  assert.match(disclosure, /2026-09-12 13:59 HKT/);
  assert.match(disclosure, /并非接口身份认证/);
  assert.doesNotMatch(disclosure + mark, /U\d{6,}|accountId|token|username/);
  const html = `<details><summary>报告说明</summary>${disclosure}</details>${mark}`;
  assert.deepEqual(validatePublicationAssociation(html, snapshot(), context()), saved);
  assert.throws(() => validatePublicationAssociation(mark, snapshot(), context()), /disclosure/);
  assert.throws(() => validatePublicationAssociation(`<!--${disclosure}-->${mark}`, snapshot(), context()), /hidden/);
  assert.throws(() => validatePublicationAssociation(`<template>${disclosure}</template>${mark}`, snapshot(), context()), /hidden/);
  assert.throws(() => validatePublicationAssociation(html + disclosure, snapshot(), context()), /disclosure/);
  assert.throws(() => validatePublicationAssociation(html.replace(ASSOCIATION_DISCLOSURE_ID, 'other'), snapshot(), context()), /disclosure/);
});

function gitFixture(value = policy()) {
  const raw = Buffer.from(associationPolicyText(value));
  const blob = crypto.createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
  const calls = [];
  const runGit = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'remote') return 'https://github.com/huanwujoy-crypto/fee-console.git\n';
    if (args[0] === 'fetch' || args[0] === 'update-ref') return '';
    if (args[0] === 'rev-parse') return `${SHA}\n`;
    if (args[0] === 'ls-tree') return `100644 blob ${blob}\t${ASSOCIATION_POLICY_PATH}\n`;
    if (args[0] === 'cat-file') return raw;
    throw new Error('unexpected command');
  };
  return { raw, blob, calls, runGit };
}

test('every trusted lookup fetches network main into an isolated ref, verifies exact blob and removes temporary ref', () => {
  const fake = gitFixture();
  const result = loadTrustedAssociationPolicy({ cwd: '/synthetic', now: NOW, runGit: fake.runGit });
  assert.equal(result.policyBlob, fake.blob);
  assert.equal(result.policyCommit, SHA);
  assert.deepEqual(result.policy, policy());
  assert.equal(result.checkedAt, iso(NOW));
  assert.deepEqual(fake.calls.map(call => call.args[0]), ['remote', 'fetch', 'rev-parse', 'ls-tree', 'cat-file', 'update-ref']);
  assert.match(fake.calls[1].args.at(-1), /^refs\/heads\/main:refs\/xuan-ib-policy-check\//);
  const target = fake.calls[1].args.at(-1).split(':')[1];
  assert.equal(fake.calls[2].args.at(-1), `${target}^{commit}`);
  assert.equal(fake.calls.at(-1).args.at(-1), target);
  loadTrustedAssociationPolicy({ now: NOW, runGit: fake.runGit });
  assert.equal(fake.calls.filter(call => call.args[0] === 'fetch').length, 2);
});

test('lookup does not fall back after fetch error, wrong origin, symlink policy or blob mismatch', () => {
  const fake = gitFixture();
  let fallbackAttempt = false;
  const failure = args => {
    if (args[0] === 'remote') return 'https://github.com/huanwujoy-crypto/fee-console.git\n';
    if (args[0] === 'fetch') throw new Error('sensitive credential diagnostics must not escape');
    fallbackAttempt = true;
    return fake.runGit(args);
  };
  assert.throws(() => loadTrustedAssociationPolicy({ now: NOW, runGit: failure }), error => /no cached policy/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(fallbackAttempt, false);
  assert.throws(() => loadTrustedAssociationPolicy({ now: NOW, runGit: args => args[0] === 'remote' ? 'https://example.com/untrusted.git' : fake.runGit(args) }), /approved repository/);
  assert.throws(() => loadTrustedAssociationPolicy({ now: NOW, runGit: args => args[0] === 'ls-tree' ? `120000 blob ${fake.blob}\t${ASSOCIATION_POLICY_PATH}` : fake.runGit(args) }), /regular tracked/);
  assert.throws(() => loadTrustedAssociationPolicy({ now: NOW, runGit: args => args[0] === 'cat-file' ? Buffer.from('{}') : fake.runGit(args) }), /blob does not match/);
});

test('trusted lookup can inspect inactive and revoked shape for gate routing but defaults fail closed', () => {
  for (const value of [policy({ status: 'inactive', validFrom: null, expiresAt: null }), policy({ status: 'revoked' }), policy({ expiresAt: iso(NOW) })]) {
    const fake = gitFixture(value);
    assert.equal(loadTrustedAssociationPolicy({ now: NOW, runGit: fake.runGit, requireActive: false }).policy.status, value.status);
    assert.throws(() => loadTrustedAssociationPolicy({ now: NOW, runGit: fake.runGit }));
  }
});

function journalFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-association-test-'));
  const journalPath = path.join(directory, 'run.jsonl');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let elapsed = -1000;
  const clock = () => ({ wallNow: () => NOW + elapsed, monotonicNowMs: () => elapsed + 1000 });
  initRunJournal(journalPath, clock()); elapsed += 100;
  startJournalStage(journalPath, 'bootstrap', clock()); elapsed += 100;
  finishJournalStage(journalPath, 'bootstrap', {}, clock());
  return { journalPath, advance: ms => { elapsed += ms; }, clock };
}

test('pre-read receipt is tied to immutable init bytes after bootstrap and before either financial stage', async t => {
  const fixture = journalFixture(t);
  const result = await createPreReadAssociationReceipt(snapshot(), { journalPath: fixture.journalPath, now: NOW, edition: 'adhoc', previousSourceSha: PRIOR });
  const init = fs.readFileSync(fixture.journalPath, 'utf8').split('\n')[0];
  assert.equal(result.runId, crypto.createHash('sha256').update(init).digest('hex'));
  assert.equal(result.policyCheckedAt, iso(NOW));
  const before = fs.readFileSync(fixture.journalPath, 'utf8');
  await createPreReadAssociationReceipt(snapshot(), { journalPath: fixture.journalPath, now: NOW, edition: 'adhoc', previousSourceSha: PRIOR });
  assert.equal(fs.readFileSync(fixture.journalPath, 'utf8'), before);
  fixture.advance(1000); startJournalStage(fixture.journalPath, 'sharesight-read', fixture.clock());
  await assert.rejects(createPreReadAssociationReceipt(snapshot(), { journalPath: fixture.journalPath, now: NOW, previousSourceSha: PRIOR }), /no financial stage/);
});

test('pre-read check rejects an earlier lookup and previously completed or failed financial read', async t => {
  const fixture = journalFixture(t);
  await assert.rejects(createPreReadAssociationReceipt(snapshot({ checkedAt: iso(NOW - 900) }), { journalPath: fixture.journalPath, now: NOW, previousSourceSha: PRIOR }), /follow this run bootstrap/);
  fixture.advance(100); startJournalStage(fixture.journalPath, 'ib-read', fixture.clock());
  fixture.advance(100); finishJournalStage(fixture.journalPath, 'ib-read', { status: 'failed', errorCode: 'TEST_FAILURE' }, fixture.clock());
  await assert.rejects(createPreReadAssociationReceipt(snapshot(), { journalPath: fixture.journalPath, now: NOW, previousSourceSha: PRIOR }), /no financial stage/);
});
