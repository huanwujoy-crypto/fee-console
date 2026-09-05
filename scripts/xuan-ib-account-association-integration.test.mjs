import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareReport, runPrepareCli } from './xuan-ib-report-prepare.mjs';
import { buildSourceEvidence } from './xuan-ib-source-adapter.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { fingerprint, APPROVED_IB_ACCOUNT_ID, IB_ENDPOINTS } from './xuan-ib-run-manifest.mjs';
import { initRunJournal, startJournalStage, finishJournalStage, showRunJournal } from './xuan-ib-run-clock.mjs';
import {
  associationPolicyBlob, createPreReadAssociationReceipt,
  extractAssociationReceipt, renderAssociationDisclosure, renderAssociationReceipt,
} from './xuan-ib-account-association.mjs';
import { checkAssociationPublication } from './xuan-ib-account-association-publication.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousHtml = fs.readFileSync(path.join(repoRoot, 'xuan-ib/latest.html'), 'utf8');
const previousMeta = JSON.parse(fs.readFileSync(path.join(repoRoot, 'xuan-ib/latest.meta.json')));
const etfPolicy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'claude/xuan-ib-policy-v2.json')));
const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'claude/xuan-ib-portfolio-registry.json')));
const template = html => {
  const all = [...html.matchAll(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/g)];
  assert.equal(all.length, 1);
  return all[0];
};
const priorTemplate = template(previousHtml);
const priorState = parseDecisionJson(priorTemplate[1], 2_000_000);
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(t,{positionsFallback=false}={}) {
  const now = Date.now(), epoch = now - 30_000;
  const stamp = offset => new Date(epoch + offset).toISOString();
  const clock = offset => ({ wallNow: () => epoch + offset, monotonicNowMs: () => offset });
  const dataDate = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const hkt = `${dataDate} 12:00 HKT`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-recurring-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'run.jsonl');
  initRunJournal(journalPath, clock(0));
  startJournalStage(journalPath, 'bootstrap', clock(500));
  finishJournalStage(journalPath, 'bootstrap', {}, clock(900));
  const policy = {
    schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
    basis: 'owner-attested-recurring-v1', status: 'active', purpose: 'xuan-ib-read-only-report',
    editions: ['adhoc'], publisher: 'claude-verified-candidate-v1',
    validFrom: stamp(-1000), expiresAt: stamp(7 * 86_400_000 - 1000),
  };
  const snapshotAt = offset => ({ policy, policyCommit: 'a'.repeat(40), policyBlob: associationPolicyBlob(policy), checkedAt: stamp(offset) });
  const receipt = await createPreReadAssociationReceipt(snapshotAt(2000), {
    journalPath, now: epoch + 2000, edition: 'adhoc', previousSourceSha: previousMeta.sourceSha,
  });
  for (const [name, start, end] of [
    ['ib-read', 5000, 10_000], ['sharesight-read', 11_000, 12_000],
    ['validate', 13_000, 14_000], ['derive', 15_000, 16_000], ['narrative', 17_000, 18_000],
  ]) {
    startJournalStage(journalPath, name, clock(start));
    finishJournalStage(journalPath, name, positionsFallback&&name==='ib-read'?{status:'degraded',errorCode:'IB_POSITIONS_FALLBACK'}:{}, clock(end));
  }
  const captured = (raw, start, end) => ({ raw, status: 'ok', retries: 0,
    startedAt: stamp(start), completedAt: stamp(end), rawFingerprint: fingerprint(raw) });
  const raws = {
    accountSummary: { currency: 'USD', net_liquidation: 100, total_cash_value: 10 },
    balances: { balances: [] }, positions: { positions: [{ contract_description: 'SYNTH', position: 1, market_price: 100, market_value: 100, currency: 'USD' }] },
    orders: { orders: [] }, trades: { trades: [] },
  };
  const input = {
    edition: 'adhoc', dataDate, previousSourceSha: previousMeta.sourceSha,
    ib: Object.fromEntries(IB_ENDPOINTS.map((name, index) => [name, captured(raws[name], 5100 + index * 900, 5200 + index * 900)])),
    sharesight: registry.portfolios.filter(item => item.requiredEachReport).map(item => captured({ result: {
      mode: 'read_only', portfolio: { id: item.portfolioId, currency_code: 'USD' },
      data: { report: { portfolio_id: item.portfolioId, value: 100, end_date: dataDate,
        currency: { code: 'USD' }, holdings: [], cash_accounts: [] } },
    } }, 11_100, 11_200)),
  };
  if(positionsFallback){
    const raw={isError:true,error:'SYNTHETIC_UNAVAILABLE'};
    input.ib.positions={...captured(raw,6900,7000),status:'failed',errorCode:'SYNTHETIC_UNAVAILABLE'};
    input.sharesight.find(item=>item.raw.result.portfolio.id===936247).completedUsTradingDayLag=1;
  }
  const associationSnapshot = snapshotAt(30_000);
  const evidence = buildSourceEvidence(input, registry, { associationReceipt: receipt, associationSnapshot, journalPath, now });
  const card = title => ({ title, asOfHkt: hkt, lines: ['合成测试，不是金融数据。'], columns: ['项目', '状态'], rows: [['合成', '仅测试']] });
  const view = {
    schemaVersion: 1, edition: 'adhoc', dataDate, asOfHkt: hkt, marketContext: '合成集成测试',
    alerts: [{ level: 'warning', text: '合成测试，不得发布。' }], summary: ['合成一。', '合成二。', '合成三。'],
    kpis: [
      { label: '合成 NAV', value: 100, format: 'usd', asOfHkt: hkt, note: '合成' },
      { label: '合成现金', value: 10, format: 'usd', asOfHkt: hkt, note: '合成' },
      { label: '合成比例', value: 1, format: 'percent', asOfHkt: hkt, note: '合成' },
    ],
    holdings: { status: 'ok', asOfHkt: hkt, authoritativeValueUsd: 100, note: '合成持仓。',
      rows: [{ symbol: 'SYNTH', market: 'TEST', quantity: 1, price: 100, priceCurrency: 'USD', marketValueUsd: 100,
        changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' }] },
    risk: [card('② 风险')], allocation: [card('④ 配置')], rotation: card('换仓'), events: card('日历未查询'),
    decisions: priorState.decisions.map(item => ({ decisionId: item.decisionId, asOfHkt: hkt, fact: '合成事实，保留历史。', isNew: false })),
    observations: ['合成观察'], notes: ['版次与时点：合成。', '数据与口径：合成。', '只读，不执行交易。'],
    cashPlan: { schemaVersion: 2, status: 'unavailable' },
  };
  if(positionsFallback)view.holdings.status='fallback';
  const options = { previousHtml, previousMeta, policy: etfPolicy, registry, journalPath, associationSnapshot, now };
  return { now, epoch, stamp, directory, journalPath, policy, receipt, associationSnapshot, input, evidence, view, options };
}

test('recurring prepare runs the actual guard, preserves old receipts and publishes only minimal association evidence', async t => {
  const f = await fixture(t), original = clone(f.input), originalEvidence = clone(f.evidence);
  const prepared = prepareReport(f.view, f.evidence, f.options);
  assert.equal(prepared.result.status, 'prepared-not-published');
  assert.deepEqual(extractAssociationReceipt(prepared.html), f.receipt);
  assert.equal(template(prepared.html)[0], priorTemplate[0]);
  assert.deepEqual(parseDecisionJson(template(prepared.html)[1], 2_000_000).receipts, priorState.receipts);
  assert.deepEqual(f.input, original);
  assert.deepEqual(f.evidence, originalEvidence);
  assert.equal(Object.hasOwn(f.input.ib.accountSummary.raw, 'account_id'), false);
  assert.equal(fs.readdirSync(f.directory).join('|'), 'run.jsonl');
  for (const forbidden of [APPROVED_IB_ACCOUNT_ID, 'consentRowObserved', 'observationFingerprint', 'manual-consent-once-v1', ...IB_ENDPOINTS.map(name => fingerprint(f.input.ib[name].raw))]) {
    assert.equal(prepared.html.includes(forbidden), false, `public HTML leaked ${forbidden}`);
  }
  const checked = checkAssociationPublication(prepared.html, f.associationSnapshot, {
    now: Date.now(), previousSourceSha: previousMeta.sourceSha,
  });
  assert.deepEqual(checked, { mode: 'owner-attested-recurring-v1', freshRead: true });
  const journal = showRunJournal(f.journalPath);
  assert.equal(journal.stages.find(item => item.name === 'render').status, 'ok');
  assert.equal(journal.stages.find(item => item.name === 'guard').status, 'ok');
});

test('recurring preparation retains the existing fresh Sharesight positions fallback without inventing a successful IB read',async t=>{
  const f=await fixture(t,{positionsFallback:true});
  const source=f.evidence.sources.ib.positions;
  assert.equal(source.asOf,null);assert.equal(source.fingerprint,null);
  assert.equal(source.attemptCompletedAt,f.stamp(7000));
  const prepared=prepareReport(f.view,f.evidence,f.options);
  assert.equal(prepared.result.degraded,true);
  assert.ok(prepared.html.includes('持仓使用获批替代源'));
  assert.equal(template(prepared.html)[0],priorTemplate[0]);
  assert.equal(showRunJournal(f.journalPath).stages.find(item=>item.name==='ib-read').status,'degraded');
});

test('current policy cannot be stripped, changed, expired or revoked after successful preparation', async t => {
  const f = await fixture(t), prepared = prepareReport(f.view, f.evidence, f.options);
  const receiptMarkup = renderAssociationReceipt(f.receipt), disclosure = renderAssociationDisclosure(f.receipt, f.associationSnapshot);
  const check = (html, snapshot = f.associationSnapshot) => checkAssociationPublication(html, snapshot, { now: Date.now(), previousSourceSha: previousMeta.sourceSha });
  const stripped = prepared.html.replace(receiptMarkup, '').replace(disclosure, '').replace(' data-account-scope-basis="owner-attested-recurring-v1"', '');
  assert.throws(() => check(stripped), /requires its recurring receipt/);
  assert.throws(() => check(prepared.html.replace(disclosure, '')), /disclosure/);
  assert.throws(() => check(prepared.html.replace(receiptMarkup, '')), /canonical body basis/);
  assert.throws(() => check(prepared.html.replace('<summary>报告说明', '<summary>其他')), /folded report explanation/);
  for (const change of [
    { status: 'revoked' }, { expiresAt: new Date(Date.now() - 1).toISOString() },
    { expiresAt: new Date(Date.parse(f.policy.expiresAt) - 1000).toISOString() },
  ]) {
    const policy = { ...f.policy, ...change };
    const altered = { ...f.associationSnapshot, policy, policyBlob: associationPolicyBlob(policy), checkedAt: new Date().toISOString() };
    assert.throws(() => check(prepared.html, altered), /revoked|expired|changed/);
  }
});

test('prepare rejects cross-run, missing snapshot and read-before-policy evidence before rendering', async t => {
  const f = await fixture(t);
  assert.throws(() => prepareReport(f.view, f.evidence, { ...f.options, associationSnapshot: null }), /snapshot is required/);
  assert.throws(() => prepareReport(f.view, f.evidence, { ...f.options, manualConsentStore: path.join(f.directory, 'not-a-store') }), /never the manual consent store/);
  const forged = clone(f.evidence); forged.sources.ib.accountAssociation.runId = 'e'.repeat(64);
  assert.throws(() => prepareReport(f.view, forged, f.options), /does not bind/);
  const before = clone(f.evidence); before.sources.ib.accountAssociation.policyCheckedAt = f.stamp(800);
  assert.throws(() => prepareReport(f.view, before, f.options), /follow completed bootstrap/);
  const badRead = clone(f.evidence); badRead.sources.sharesight[0].readStartedAt = f.stamp(2000);
  assert.throws(() => prepareReport(f.view, badRead, f.options), /outside journal read stage/);
  assert.equal(showRunJournal(f.journalPath).timing.completedStages.includes('render'), false);
});

test('operational prepare path independently requests current policy and writes only guarded candidate bytes', async t => {
  const f = await fixture(t);
  const viewFile = path.join(f.directory, 'synthetic-view.json'), sourcesFile = path.join(f.directory, 'synthetic-sources.json');
  const outputFile = path.join(f.directory, 'synthetic-candidate.html');
  fs.writeFileSync(viewFile, JSON.stringify(f.view), { mode: 0o600 });
  fs.writeFileSync(sourcesFile, JSON.stringify(f.evidence), { mode: 0o600 });
  let reads = 0;
  const result = runPrepareCli([viewFile, sourcesFile, outputFile, '--journal', f.journalPath], {
    loadAssociationPolicy(options) {
      reads += 1;
      assert.equal(options.cwd, repoRoot);
      assert.equal(options.requireActive, false);
      return { ...f.associationSnapshot, checkedAt: new Date().toISOString() };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.status, 'prepared-not-published');
  assert.deepEqual(extractAssociationReceipt(fs.readFileSync(outputFile, 'utf8')), f.receipt);
  assert.equal(showRunJournal(f.journalPath).stages.find(item => item.name === 'candidate-prep').status, 'ok');
  assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
  assert.throws(() => runPrepareCli([viewFile, sourcesFile, outputFile, '--journal', f.journalPath]), /already exists/);
});
