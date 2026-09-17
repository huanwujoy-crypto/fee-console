import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLEEP_PRIORITY_BODY_ATTRIBUTE, createSleepPriorityDelivery, renderSleepPriorityTransport,
  checkSleepPriorityPublication, classifySleepPublication, nextSleepPriorityAction,
  associationAnchorAfterPriority,
} from './xuan-ib-sleep-priority.mjs';

const started = '2026-09-16T13:30:00.000Z';
const delivery = () => createSleepPriorityDelivery({
  dataDate: '2026-09-16', runId: 'run-20260916-pm', runStartedAt: started,
  priorityReadyAt: '2026-09-16T13:36:00.000Z', previousSourceSha: 'a'.repeat(40),
});
const html = value => `<!doctype html><html><body ${SLEEP_PRIORITY_BODY_ATTRIBUTE}><span class="date">2026-09-16 · 临时版 · 睡前速览 · 完整报告更新中</span>${renderSleepPriorityTransport(value)}</body></html>`;

test('independent fast lane is eligible as soon as its verified capture is ready', () => {
  const value = delivery();
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.publishEligibleAt, started);
  assert.deepEqual(checkSleepPriorityPublication(html(value), { expectedDate: value.dataDate }), value);
  assert.deepEqual(classifySleepPublication(html(value)), {
    kind: 'priority', dataDate: '2026-09-16', priorityKey: 'pm:2026-09-16', eligibleAtEpoch: 1789565400,
  });
});

test('previous ten-minute priority pages remain readable without reopening their early gate', () => {
  const legacy = { ...delivery(), schemaVersion: 1, publishEligibleAt: '2026-09-16T13:40:00.000Z' };
  assert.deepEqual(checkSleepPriorityPublication(html(legacy)), legacy);
  assert.throws(() => checkSleepPriorityPublication(html({ ...legacy, publishEligibleAt: started })), /delivery version/);
});

test('refuses marker tampering, lookalikes and a priority page presented as pm', () => {
  const value = delivery();
  assert.throws(() => checkSleepPriorityPublication(html(value).replace(SLEEP_PRIORITY_BODY_ATTRIBUTE, '')), /body marker/);
  assert.throws(() => checkSleepPriorityPublication('<html><body>睡前速览 · 完整报告更新中</body></html>', { edition: 'adhoc' }), /canonical delivery marker/);
  assert.throws(() => checkSleepPriorityPublication(html(value).replace('临时版', '睡前版')), /adhoc/);
  assert.throws(() => createSleepPriorityDelivery({ ...value, runStartedAt: value.priorityReadyAt, priorityReadyAt: value.runStartedAt }), /precedes/);
});

const state = overrides => ({
  runId: 'run-20260916-pm', dataDate: '2026-09-16', startedAt: started,
  now: '2026-09-16T13:39:59.000Z', priorityReadyAt: '2026-09-16T13:36:00.000Z',
  priorityPublishedAt: null, fullReadyAt: null, fullPublishedAt: null, ...overrides,
});

test('coordinator publishes a ready independent priority without waiting for the full report', () => {
  assert.equal(nextSleepPriorityAction(state({})), 'publish-priority');
  assert.equal(nextSleepPriorityAction(state({ priorityReadyAt: null })), 'wait-for-priority');
  assert.equal(nextSleepPriorityAction(state({ now: '2026-09-16T13:45:00.000Z', fullReadyAt: '2026-09-16T13:44:00.000Z' })), 'publish-full');
  assert.equal(nextSleepPriorityAction(state({ now: '2026-09-16T13:45:00.000Z', priorityPublishedAt: '2026-09-16T13:40:30.000Z' })), 'continue-full');
  assert.equal(nextSleepPriorityAction(state({ now: '2026-09-16T13:46:00.000Z', fullReadyAt: '2026-09-16T13:44:00.000Z', fullPublishedAt: '2026-09-16T13:45:00.000Z' })), 'complete');
});

test('same-date full PM may honor its pre-read anchor across a published priority', () => {
  const prior = 'a'.repeat(40), prioritySha = 'b'.repeat(40);
  const publishedHtml = html(delivery());
  const select = (changes = {}) => associationAnchorAfterPriority({
    candidateEdition: 'pm', candidatePreviousSourceSha: prior,
    publishedHtml, publishedSourceSha: prioritySha, dataDate: '2026-09-16', ...changes,
  });
  assert.equal(select(), prior);
  assert.equal(select({ candidatePreviousSourceSha: prioritySha }), prioritySha);
  assert.equal(select({ candidateEdition: 'adhoc' }), prioritySha);
  assert.equal(select({ dataDate: '2026-09-17' }), prioritySha);
  assert.equal(select({ candidatePreviousSourceSha: 'c'.repeat(40) }), prioritySha);
  assert.equal(select({ publishedHtml: '<html><body></body></html>' }), prioritySha);
});
