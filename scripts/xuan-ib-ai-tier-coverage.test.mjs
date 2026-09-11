import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareReport } from './xuan-ib-report-prepare.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { fingerprint, APPROVED_IB_ACCOUNT_ID } from './xuan-ib-run-manifest.mjs';
import { inactiveAssociationSnapshot } from './xuan-ib-association-test-fixture.mjs';
import { buildAiTierCoverage, renderAiTierCoverage } from './xuan-ib-ai-tier-coverage.mjs';
import {
  AUTO_EXCLUSION_REASONS, autoNotifyIdFromRecordId, classifyFirstSeenPosition,
  decideAutoNotification, publishedAutoNotifyIds,
} from './xuan-ib-auto-classification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(root, 'scripts/handover-guard.mjs');
const previousHtml = fs.readFileSync(path.join(root, 'xuan-ib/latest.html'), 'utf8');
const previousMeta = JSON.parse(fs.readFileSync(path.join(root, 'xuan-ib/latest.meta.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(root, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
const decisionState = parseDecisionJson(previousHtml.match(
  /<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)?.[1], 2_000_000);

const dataDate = previousMeta.dataDate;
const hktStamp = `${dataDate} 07:47–08:10 HKT`;
const instant = `${dataDate}T08:10:00+08:00`;
const context = {
  previousHtml, previousMeta, policy, registry,
  get associationSnapshot() { return inactiveAssociationSnapshot(); },
};
const card = (title) => ({ title, asOfHkt: hktStamp, lines: ['合成覆盖测试；不是金融数据。'],
  columns: ['项目', '状态'], rows: [['合成项', '仅测试']] });

// Two constituents, shaped like rows a real run normalizes out of its payloads:
// one ordinary stock nobody has ever classified, and one ETF that must never
// acquire a single-stock pressure tier.
const holding = (symbol, market) => ({ symbol, market, quantity: 1, price: 100, priceCurrency: 'USD',
  marketValueUsd: 100, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' });
const view = () => ({ schemaVersion: 1, edition: 'am', dataDate, asOfHkt: hktStamp,
  marketContext: '合成覆盖测试', alerts: [{ level: 'warning', text: '合成测试，不得发布。' }],
  summary: ['合成摘要一。', '合成摘要二。', '合成摘要三。'],
  kpis: [{ label: '合成 NAV', value: 200, format: 'usd', asOfHkt: hktStamp, note: '合成数值' },
    { label: '合成现金', value: null, format: 'usd', asOfHkt: hktStamp, note: '缺失不填零' },
    { label: '合成比例', value: 1, format: 'percent', asOfHkt: hktStamp, note: '仅测试' }],
  holdings: { status: 'ok', asOfHkt: hktStamp, authoritativeValueUsd: 200, note: '合成持仓。',
    rows: [holding('NEWCO', 'NASDAQ'), holding('GLDETF', 'NYSE')] },
  risk: [card('② 风险')], allocation: [card('④ 配置')], rotation: card('换仓'), events: card('日历未查询'),
  decisions: decisionState.decisions.map(item => ({ decisionId: item.decisionId, asOfHkt: hktStamp,
    fact: '合成事实；不改历史意见。', isNew: false })),
  observations: ['合成观察'], notes: ['版次与时点：合成。', '数据与口径：合成。', '只读验证，不执行交易。'],
  cashPlan: { schemaVersion: 2, status: 'unavailable' } });

const evidence = () => {
  const source = (label) => ({ status: 'ok', asOf: instant, retries: 0, fingerprint: fingerprint({ synthetic: label }) });
  return { schemaVersion: 1, edition: 'am', dataDate, previousSourceSha: previousMeta.sourceSha, sources: {
    ib: { accountId: APPROVED_IB_ACCOUNT_ID, accountScopeConfirmed: true,
      ...Object.fromEntries(['accountSummary', 'balances', 'positions', 'orders', 'trades']
        .map(name => [name, source(name)])) },
    sharesight: registry.portfolios.filter(item => item.requiredEachReport).map(item => ({
      portfolioId: item.portfolioId, role: item.role, ...source(item.portfolioId),
      ...(item.portfolioId === 936247 ? { completedUsTradingDayLag: 0 } : {}) })) } };
};

const constituent = (over) => ({ symbol: 'NEWCO', venue: 'NASDAQ', portfolioId: '1350094',
  holdingId: '99000001', instrumentId: '99000001', currency: 'USD', assetType: 'STK',
  marketValueUsd: 100, valueDate: dataDate, identityVerified: true, firstSeen: true, ...over });
const constituents = () => [constituent({}),
  constituent({ symbol: 'GLDETF', venue: 'NYSE', holdingId: '99000002', instrumentId: '99000002', assetType: 'ETF' })];

// ---------------------------------------------------------------------------
// Gap 2: the AUTO path has a production caller, reached from the real assembly
// entry point rather than from a unit test of the helper.
// ---------------------------------------------------------------------------

test('a first-seen stock reaches the rendered report and the trusted guard through the real prepare path', () => {
  const prepared = prepareReport(view(), evidence(), { ...context, riskConstituents: constituents() });
  // `prepareReport` runs the actual trusted guard on the actual candidate
  // bytes, so reaching this line is the guard accepting the page.
  assert.equal(prepared.result.status, 'prepared-not-published');
  const html = prepared.html;

  // The constituent universe the table declares, in machine-readable form.
  assert.match(html, /data-holdings-universe-v1="2"/);
  assert.match(html, /data-holding-symbol="NEWCO"/);
  assert.match(html, /data-holding-symbol="GLDETF"/);

  // The complete records manifest: one AUTO classification, one named exclusion.
  const records = JSON.parse(html.match(
    /<template id="xuan-ib-ai-tier-records-v1" type="application\/json">([\s\S]*?)<\/template>/)[1]);
  assert.deepEqual(records, [
    { symbol: 'NEWCO', namespace: 'AUTO',
      recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:99000001', status: 'classified' },
    { symbol: 'GLDETF', namespace: 'AUTO',
      recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:99000002', status: 'excluded',
      reason: AUTO_EXCLUSION_REASONS.ASSET_TYPE_NOT_ORDINARY_STOCK },
  ]);

  // The numerator/denominator split the report actually publishes: the new
  // stock is inside the numerator, the ETF is outside it and still inside the
  // denominator, and the reason is named rather than implied.
  assert.match(html, /data-ai-tier-coverage-v1="1\/2"/);
  assert.match(html, /共 2 项，已分类 1 项计入分子，1 项按列名原因排除但仍在分母内/);
  assert.match(html, /data-ai-tier-symbol="NEWCO" data-ai-tier-namespace="AUTO"/);
  assert.match(html, /data-ai-tier-excluded="GLDETF" data-ai-tier-reason="asset-type-not-ordinary-stock"/);
  // An AUTO record is this period's real classification, never a placeholder.
  for (const word of ['临时', '待确认', '待裁决']) {
    assert.equal(html.includes(`NEWCO${word}`), false);
  }
  // And it remains measurement only: the record stays in its own AUTO namespace
  // under its own policy revision, and mints no owner or delegated approval.
  assert.equal(html.includes('AUTO-20260911-NEWSTK-T1-R1'), true);
  assert.equal(/(?:WU|DELEG)-\d{8}-NEWCO/.test(html), false);
});

test('an ordinary scheduled edition cannot show holdings without resolved constituents', () => {
  // The wiring is mandatory, not merely available: omitting it fails at the
  // assembly step rather than producing a page whose coverage nobody checked.
  assert.throws(() => prepareReport(view(), evidence(), context),
    /require resolved AI-tier risk constituents/);
  // The records must describe this report's own table, not another list.
  assert.throws(() => prepareReport(view(), evidence(),
    { ...context, riskConstituents: [constituent({})] }),
  /do not cover exactly the reported holdings/);
});

test('every constituent is classified or excluded with an enumerated reason, and never guessed', () => {
  const coverage = buildAiTierCoverage([
    constituent({}),
    constituent({ symbol: 'UNKNOWNTYPE', holdingId: '99000003', instrumentId: '99000003', assetType: 'WIDGET' }),
    constituent({ symbol: 'NOTNEW', holdingId: '99000004', instrumentId: '99000004', firstSeen: false }),
    constituent({ symbol: 'UNVERIFIED', holdingId: '99000005', instrumentId: '99000005', identityVerified: false }),
    // The owner's own identity-bound rule still wins, and is recorded as `WU`.
    constituent({ symbol: 'MRVL', holdingId: '28987468', instrumentId: '28987468', firstSeen: false }),
  ]);
  assert.deepEqual(coverage.entries.map(entry => [entry.symbol, entry.namespace, entry.status, entry.reason ?? null]), [
    ['NEWCO', 'AUTO', 'classified', null],
    // An unrecognized asset type is never coerced towards the nearest known one.
    ['UNKNOWNTYPE', 'AUTO', 'excluded', AUTO_EXCLUSION_REASONS.ASSET_TYPE_UNKNOWN],
    ['NOTNEW', 'AUTO', 'excluded', AUTO_EXCLUSION_REASONS.NOT_FIRST_SEEN],
    ['UNVERIFIED', 'AUTO', 'excluded', AUTO_EXCLUSION_REASONS.IDENTITY_UNVERIFIED],
    ['MRVL', 'WU', 'classified', null],
  ]);
  assert.equal(coverage.entries.find(entry => entry.symbol === 'MRVL').recordId, 'WU-20260831-MRVL-T1');
  assert.deepEqual(coverage.coverage.numeratorSymbols, ['NEWCO', 'MRVL']);
  assert.equal(coverage.coverage.total, 5);
  // There is no third outcome: nothing is left unresolved, zeroed or guessed.
  assert.equal(coverage.entries.every(entry => ['classified', 'excluded'].includes(entry.status)), true);
  assert.equal(coverage.entries.every(entry => entry.status === 'classified' || entry.reason), true);
  // A holding that reaches an approved rule but is not the instrument that rule
  // approved is disclosed, never stretched onto the owner's approval.
  const mismatched = buildAiTierCoverage([constituent({ symbol: 'NOTMRVL', holdingId: '28987468',
    instrumentId: '28987468', firstSeen: false })]);
  assert.equal(mismatched.entries[0].status, 'excluded');
  assert.equal(mismatched.entries[0].reason, AUTO_EXCLUSION_REASONS.OWNER_RULE_IDENTITY_MISMATCH);
  // One symbol may carry only one record, or reconciliation would depend on order.
  assert.throws(() => buildAiTierCoverage([constituent({}), constituent({ holdingId: '99000009',
    instrumentId: '99000009' })]), /DUPLICATE_CONSTITUENT/);
  // A constituent carrying a field this module does not check is refused rather
  // than classified more widely than the approved policies allow.
  assert.throws(() => buildAiTierCoverage([{ ...constituent({}), tier: 'T3' }]), /CONSTITUENT_FIELDS_UNEXPECTED/);
});

// ---------------------------------------------------------------------------
// Gap 4: the blocking check is structural, not a scan of prose.
// ---------------------------------------------------------------------------

const runGuard = (t, html) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-ai-tier-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidate = path.join(dir, 'candidate.html'), prior = path.join(dir, 'previous.html');
  const policyFile = path.join(dir, 'policy.json'), snapshotFile = path.join(dir, 'association.json');
  fs.writeFileSync(candidate, html); fs.writeFileSync(prior, previousHtml);
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  fs.writeFileSync(snapshotFile, JSON.stringify(inactiveAssociationSnapshot()));
  return spawnSync(process.execPath, [guard, candidate, dataDate, prior], { encoding: 'utf8',
    env: { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: previousMeta.sourceSha,
      XUAN_IB_PREVIOUS_HTML_BLOB: previousMeta.htmlBlob, XUAN_IB_POLICY_V2_JSON: policyFile,
      XUAN_IB_ASSOCIATION_SNAPSHOT_JSON: snapshotFile } });
};

test('a symbol dropped from the records fails the guard even with no prose about it at all', t => {
  const accepted = prepareReport(view(), evidence(), { ...context, riskConstituents: constituents() });
  assert.equal(runGuard(t, accepted.html).status, 0, 'the untouched candidate must pass');

  // Silently drop GLDETF: remove its manifest entry AND every sentence that
  // mentions it, so nothing in the prose confesses to anything. The old prose
  // scan finds no trigger phrase here and would pass the page unchanged.
  const records = accepted.html.match(
    /<template id="xuan-ib-ai-tier-records-v1" type="application\/json">([\s\S]*?)<\/template>/)[1];
  const trimmed = JSON.stringify(JSON.parse(records).filter(entry => entry.symbol !== 'GLDETF'));
  const silent = accepted.html
    .replace(records, trimmed)
    .replace(/<p data-ai-tier-excluded="GLDETF"[\s\S]*?<\/p>/, '');
  // The page genuinely says nothing about it: no exclusion wording anywhere.
  assert.equal(/待核验|待分类|未分类|未含|未计入分子|边界未定义|无\s*已?批准\s*tier/.test(
    silent.match(/<div class="pane p2">([\s\S]*?)(?=<div class="pane p3">)/)[1]), false);
  const dropped = runGuard(t, silent);
  assert.notEqual(dropped.status, 0);
  assert.match(dropped.stderr + dropped.stdout,
    /GLDETF is a reported holding with no machine-readable AI tier record/);

  // Removing the row from the table as well does not help either: the declared
  // universe and the rendered rows must agree, so an omission is arithmetic.
  const hidden = silent.replace(/<tr data-holding-symbol="GLDETF"[\s\S]*?<\/tr>/, '');
  const hiddenResult = runGuard(t, hidden);
  assert.notEqual(hiddenResult.status, 0);
  assert.match(hiddenResult.stderr + hiddenResult.stdout, /declares 2 constituents but names 1/);

  // And a record for something this report does not hold cannot be used to make
  // the coverage arithmetic look complete.
  const invented = accepted.html.replace(records,
    JSON.stringify([...JSON.parse(records), { symbol: 'GHOST', namespace: 'AUTO',
      recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:99000099', status: 'classified' }]));
  const ghost = runGuard(t, invented);
  assert.notEqual(ghost.status, 0);
  assert.match(ghost.stderr + ghost.stdout, /GHOST does not correspond to any reported holding/);
});

test('the prose regression backstop still fails the cases it was written for', t => {
  // The wording-based scan is kept, not replaced: a report that does reopen a
  // delegated classification in prose still fails on that ground alone.
  const accepted = prepareReport(view(), evidence(), { ...context, riskConstituents: constituents() });
  const reopened = accepted.html.replace('<div class="pane p2">',
    '<div class="pane p2"><p>AAOI 尚无已批准 tier，未计入分子。</p>');
  const result = runGuard(t, reopened);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /AAOI T1 is already delegated/);
});

// ---------------------------------------------------------------------------
// Gap 3: "notify once" is decided against the previous trusted page and a
// verified public read-back, not against an array the caller passed in.
// ---------------------------------------------------------------------------

const autoRecord = () => classifyFirstSeenPosition(constituent({}));

test('a first appearance notifies, and the same identity on the next run does not', t => {
  const record = autoRecord();
  // The notify id and the published record id are two spellings of the same
  // three facts, which is what makes the published page itself the durable
  // evidence of what was already notified.
  assert.equal(autoNotifyIdFromRecordId(record.classificationId), record.notifyId);

  // First ever appearance: nothing published carries this identity.
  const first = decideAutoNotification(record, { previousPageHtml: previousHtml });
  assert.equal(first.decision, 'notify');
  assert.equal(first.state, 'pending');

  // The page this run publishes, which becomes the next run's trusted previous.
  const published = prepareReport(view(), evidence(), { ...context, riskConstituents: constituents() }).html;
  assert.equal(runGuard(t, published).status, 0);
  assert.equal(publishedAutoNotifyIds(published).has(record.notifyId), true);

  // Next run, same identity under the same policy revision: already notified.
  const second = decideAutoNotification(record, { previousPageHtml: published });
  assert.equal(second.decision, 'already-notified');
  assert.equal(second.state, 'closed-earlier');
  // Still no owner artefact of any kind, on either run.
  for (const outcome of [first, second]) {
    assert.equal(outcome.createsAwaitingUser, false);
    assert.equal(outcome.requiresOwnerDecision, false);
    assert.equal(outcome.notifyOnce, true);
  }
});

test('a notification never closes without a verified public read-back', () => {
  const record = autoRecord();
  const open = { previousPageHtml: previousHtml };
  // No read-back at all.
  assert.equal(decideAutoNotification(record, open).state, 'pending');
  // A read-back that was attempted but not verified is not publication.
  assert.equal(decideAutoNotification(record,
    { ...open, publicReadBackVerified: false, closedAtHkt: `${dataDate} 08:20 HKT` }).state, 'pending');
  // A claimed verification with no instant to show for it does not close either.
  assert.equal(decideAutoNotification(record, { ...open, publicReadBackVerified: true }).state, 'pending');
  // Only a verified read-back with its own instant closes, and it closes once.
  const closed = decideAutoNotification(record,
    { ...open, publicReadBackVerified: true, closedAtHkt: `${dataDate} 08:20 HKT` });
  assert.equal(closed.state, 'delivered');
  assert.equal(closed.closedAtHkt, `${dataDate} 08:20 HKT`);
  // A truthy-looking value is not a verification.
  for (const claim of ['yes', 1, {}]) {
    assert.equal(decideAutoNotification(record,
      { ...open, publicReadBackVerified: claim, closedAtHkt: `${dataDate} 08:20 HKT` }).state, 'pending');
  }
});

test('an unreadable previous manifest is refused rather than read as nothing notified', () => {
  // Treating an unparseable previous page as empty would re-notify every
  // position it carried, which is the exact failure "notify once" must not have.
  assert.throws(() => publishedAutoNotifyIds(
    '<template id="xuan-ib-ai-tier-records-v1" type="application/json">{not json</template>'),
  /PREVIOUS_RECORDS_UNREADABLE/);
  // A page with no records at all is simply a page that notified nothing.
  assert.equal(publishedAutoNotifyIds('<html></html>').size, 0);
  assert.equal(autoNotifyIdFromRecordId('WU-20260831-MRVL-T1'), null);
});

test('rendering refuses an exclusion it cannot name', () => {
  const coverage = buildAiTierCoverage([constituent({})]);
  assert.match(renderAiTierCoverage(coverage).template, /xuan-ib-ai-tier-records-v1/);
  const forged = { ...coverage, entries: [{ symbol: 'X', namespace: 'AUTO', recordId: 'AUTO:x',
    status: 'excluded', reason: 'because-i-said-so' }] };
  assert.throws(() => renderAiTierCoverage(forged), /EXCLUSION_REASON_UNENUMERATED/);
});
