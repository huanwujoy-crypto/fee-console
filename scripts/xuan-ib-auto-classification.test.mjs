import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFirstSeenPosition, readAutoClassificationPolicy, existingOwnerRuleKeys,
  closeAutoNotification, autoNotificationState, assertNoProvisionalWording,
  renderAutoClassificationRecord, normalizeAssetType,
  AUTO_NAMESPACE, AUTO_EXCLUSION_REASONS, FORBIDDEN_PROVISIONAL_WORDS,
  AutoClassificationException,
} from './xuan-ib-auto-classification.mjs';
import { calculateDelegatedTier, SUPPORTED_TIERS } from './xuan-ib-delegated-tier.mjs';

const policy = readAutoClassificationPolicy();
// A synthetic first-seen ordinary stock. No amount below is a real holding.
const fresh = (over = {}) => ({
  symbol: 'NEWCO', venue: 'NASDAQ', custodian: 'Webull',
  portfolioId: '1350094', holdingId: '99000001', instrumentId: '99000002',
  currency: 'USD', assetType: 'STK', identityVerified: true, firstSeen: true,
  marketValueUsd: 12500, valueDate: '2026-09-10', ...over,
});
const classify = (input, extra = {}) => classifyFirstSeenPosition(input, { policy, ...extra });

test('a first-seen ordinary stock is classified now, at the most conservative approved tier', () => {
  const record = classify(fresh());
  assert.equal(record.namespace, AUTO_NAMESPACE);
  assert.equal(record.tier, 'T1');
  assert.deepEqual([record.low, record.mid, record.high], [7500, 10000, 12500]);
  // The coefficients come from the same approved whitelist the delegated reader
  // uses; this policy may not adopt its own.
  assert.deepEqual([SUPPORTED_TIERS.T1.low, SUPPORTED_TIERS.T1.mid, SUPPORTED_TIERS.T1.high],
    [policy.policy.low, policy.policy.mid, policy.policy.high]);
  // Exact cent arithmetic, not binary floating point.
  assert.equal(classify(fresh({ marketValueUsd: 10553 })).low, 6331.8);
  // It is this period's effective classification, not a status to revisit.
  assert.equal(record.effective, true);
});

test('an AUTO record never creates an owner decision, a receipt or a WU/DELEG identity', () => {
  const record = classify(fresh());
  assert.equal(record.createsAwaitingUser, false);
  assert.equal(record.mintsOwnerReceipt, false);
  assert.equal(record.requiresOwnerDecision, false);
  // The id lives in its own namespace and can never be read as an owner
  // selection or a named delegated approval.
  assert.ok(record.classificationId.startsWith('AUTO:'));
  assert.doesNotMatch(record.classificationId, /^(?:WU|DELEG)-/);
  assert.equal(Object.hasOwn(record, 'approvalId'), false);
  assert.equal(Object.hasOwn(record, 'receipt'), false);
  assert.equal(Object.hasOwn(record, 'decisionId'), false);
  assert.match(record.policyRevision, /^AUTO-\d{8}-[A-Z0-9]+-T1-R\d+$/);
  // The policy file itself must deny all of it, or the module refuses to run.
  assert.equal(policy.policy.createsAwaitingUser, false);
  assert.equal(policy.policy.mintsOwnerReceipt, false);
  assert.equal(policy.policy.coefficientChanges, false);
  assert.equal(policy.policy.accountScopeChanges, false);
  assert.equal(policy.policy.financialWrites, false);
});

test('the notification identity is stable across runs for one identity and policy revision', () => {
  const firstRun = classify(fresh());
  // A later report of the same position, with a moved value and date, is the
  // same classification under the same policy — not a new one to notify again.
  const laterRun = classify(fresh({ marketValueUsd: 13100, valueDate: '2026-09-11' }));
  assert.equal(firstRun.notifyId, laterRun.notifyId);
  assert.equal(firstRun.notifyId, `classification:1350094:99000001:${policy.policy.policyRevision}`);
  assert.equal(firstRun.notifyOnce, true);
  // A different holding is a different event and keeps its own identity.
  assert.notEqual(firstRun.notifyId, classify(fresh({ holdingId: '99000003' })).notifyId);
  // Delivery is recorded once, and only against a verified public read-back.
  assert.equal(autoNotificationState(firstRun), 'pending');
  assert.throws(() => closeAutoNotification(firstRun, { closedAtHkt: '2026-09-11 08:20 HKT' }),
    /NOTIFICATION_READBACK_REQUIRED/);
  const closed = closeAutoNotification(firstRun,
    { publicReadBackVerified: true, closedAtHkt: '2026-09-11 08:20 HKT' });
  assert.equal(closed.state, 'delivered');
  assert.equal(autoNotificationState(laterRun, { delivered: [closed.notifyId] }), 'delivered');
});

test('only an unambiguous ordinary stock qualifies; every other asset type is fail-visible', () => {
  // Explicitly excluded types never acquire a single-stock pressure tier here.
  for (const assetType of ['ETF', 'FUND', 'MUTUAL_FUND', 'BOND', 'CASH', 'COMMODITY', 'CRYPTO',
    'OPT', 'FUT', 'CFD', 'WAR', 'FX']) {
    assert.throws(() => classify(fresh({ assetType })), (error) => {
      assert.ok(error instanceof AutoClassificationException);
      assert.equal(error.code, 'ASSET_TYPE_NOT_ORDINARY_STOCK');
      // Named, disclosed and excluded with an enumerated reason.
      assert.equal(error.symbol, 'NEWCO');
      assert.equal(error.reason, AUTO_EXCLUSION_REASONS.ASSET_TYPE_NOT_ORDINARY_STOCK);
      return true;
    }, `${assetType} must never be auto-classified as T1`);
  }
  // Unknown, absent or ambiguous is not "probably a stock".
  for (const assetType of [null, undefined, '', 'STRUCTURED', 'UNIT_TRUST', 42]) {
    assert.throws(() => classify(fresh({ assetType })), /ASSET_TYPE_UNKNOWN/);
  }
  // Spelling variants of ordinary stock are one thing.
  for (const assetType of ['STK', 'stk', 'Common Stock', 'common-stock', 'ORDINARY_SHARES']) {
    assert.equal(classify(fresh({ assetType })).tier, 'T1');
  }
  assert.equal(normalizeAssetType('Common Stock'), 'COMMON_STOCK');
  assert.equal(normalizeAssetType('  '), null);
});

test('it applies only to a verified, genuinely first-seen position with no existing owner rule', () => {
  assert.throws(() => classify(fresh({ identityVerified: false })), /SOURCE_IDENTITY_UNVERIFIED/);
  assert.throws(() => classify(fresh({ firstSeen: false })), /NOT_FIRST_SEEN/);
  // An owner selection or a named delegated approval always wins; the automatic
  // policy stands aside rather than shadowing it.
  const keys = existingOwnerRuleKeys();
  assert.ok(keys.size >= 3, 'the deployed WU and DELEG rules are all considered');
  const [covered, approvalId] = [...keys.entries()][0];
  const [portfolioId, holdingId] = covered.split(':');
  assert.throws(() => classify(fresh({ portfolioId, holdingId })), (error) => {
    assert.equal(error.code, 'EXISTING_OWNER_RULE');
    assert.equal(error.reason, AUTO_EXCLUSION_REASONS.EXISTING_OWNER_RULE);
    assert.match(error.message, new RegExp(approvalId));
    return true;
  });
  // The BE identity the owner is being asked to approve as a DELEG rule is one
  // of those, so it is covered by that rule and never by this policy.
  assert.ok(keys.has('1350094:29037698'));
  assert.equal(keys.get('1350094:29037698'), 'DELEG-20260911-BE-T1');
});

test('a missing identity, value or date is a named exception, never zero and never a user decision', () => {
  for (const key of ['symbol', 'portfolioId', 'holdingId', 'instrumentId', 'currency', 'venue']) {
    assert.throws(() => classify(fresh({ [key]: '' })), /IDENTITY_INCOMPLETE/);
  }
  for (const value of [null, undefined, -1, 1.001, Number.NaN, Infinity, '12500', 1e13]) {
    assert.throws(() => classify(fresh({ marketValueUsd: value })), /VALUE_NOT_VERIFIED_USD_CENTS/);
  }
  for (const valueDate of [null, '2026-02-30', '2026-9-9', 20260909]) {
    assert.throws(() => classify(fresh({ valueDate })), /VALUE_DATE_REQUIRED/);
  }
  for (const input of [null, 'NEWCO', [], undefined]) {
    assert.throws(() => classify(input), /INPUT_MALFORMED/);
  }
  // A genuinely zero position is still calculable; it is absence that is refused.
  assert.deepEqual(
    (({ low, mid, high }) => [low, mid, high])(classify(fresh({ marketValueUsd: 0 }))), [0, 0, 0]);
  // Every failure belongs to Codex and never queues another per-stock question.
  assert.throws(() => classify(fresh({ assetType: 'ETF' })), (error) => {
    assert.equal(error.owner, 'Codex');
    assert.equal(error.requiresOwnerDecision, false);
    assert.equal(error.createsAwaitingUser, false);
    return true;
  });
});

test('the output is a real classification, never worded as provisional or pending', () => {
  const record = classify(fresh());
  const rendered = renderAutoClassificationRecord(record);
  assert.deepEqual(FORBIDDEN_PROVISIONAL_WORDS, ['临时', '待确认', '待裁决']);
  for (const word of FORBIDDEN_PROVISIONAL_WORDS) {
    assert.ok(!rendered.includes(word), `rendered record must not say ${word}`);
    assert.ok(!JSON.stringify(record).includes(word), `record must not say ${word}`);
  }
  assert.match(rendered, /data-ai-tier-namespace="AUTO"/);
  assert.match(rendered, /data-ai-tier-symbol="NEWCO"/);
  assert.match(rendered, /本期计入 AI 压力分子/);
  assert.throws(() => assertNoProvisionalWording('NEWCO 临时计入'), /PROVISIONAL_WORDING/);
  assert.equal(assertNoProvisionalWording('NEWCO 按标准 T1 计入'), 'NEWCO 按标准 T1 计入');
});

test('the automatic policy never becomes a path into the delegated owner reader', () => {
  // An AUTO record's identity is not an approval id, so it cannot be fed back
  // into the reader that applies owner approvals.
  const record = classify(fresh());
  assert.throws(() => calculateDelegatedTier({ ...fresh(), approvalId: record.classificationId }),
    /RULE_NOT_APPROVED/);
  assert.throws(() => calculateDelegatedTier(fresh(), { approvalId: record.policyRevision }),
    /RULE_NOT_APPROVED/);
});
