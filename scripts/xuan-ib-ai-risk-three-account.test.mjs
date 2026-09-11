// The three-account AI-risk universe, end to end through the production path.
//
// Round one of this repair produced modules that were correct in isolation and
// unreachable in practice. Round two wired them up but tested them against a
// single-account fixture, which is the shape that cannot expose either of the
// defects below. So this suite is deliberately built like the real thing: IB-HK
// positions, Schwab-HK holdings and Webull holdings together, with one ticker
// genuinely held in two accounts, and every assertion made on bytes that came
// out of `prepareReport` and went into the actual `handover-guard.mjs`.
//
// It exercises the two structural failures directly:
//
//   * a symbol-keyed universe, which refused the second `GOOG` outright and
//     reconciled the risk manifest against the IB-only holdings table; and
//   * a hand-authored numerator, which no code compared against the
//     classification partition it was supposed to follow from.
//
// Nothing here reads a financial account. Every market value is synthetic.
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
import { buildAiTierCoverage } from './xuan-ib-ai-tier-coverage.mjs';
import { computeAiPressure } from './xuan-ib-ai-pressure.mjs';
import { calculateDelegatedTier } from './xuan-ib-delegated-tier.mjs';
import { readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';
import { AUTO_EXCLUSION_REASONS } from './xuan-ib-auto-classification.mjs';

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

// The three account books this universe spans. Only IB-HK appears in the
// holdings table; the other two are risk constituents and nothing else, which
// is exactly why the manifest cannot be reconciled against that table.
const PORTFOLIO = { 'IB-HK': '936247', 'Schwab-HK': '936249', Webull: '1350094' };
let nextHolding = 70000000;
const at = (custodian, symbol, marketValueUsd, over = {}) => ({
  symbol, custodian, venue: over.venue ?? 'NASDAQ', portfolioId: PORTFOLIO[custodian],
  holdingId: over.holdingId ?? String(++nextHolding),
  instrumentId: over.instrumentId ?? String(10000000 + nextHolding),
  currency: 'USD', assetType: over.assetType ?? 'STK', marketValueUsd, valueDate: dataDate,
  identityVerified: over.identityVerified ?? true, firstSeen: over.firstSeen ?? false,
});

// One universe, deliberately covering every resolution path there is.
function universe() {
  nextHolding = 70000000;
  return [
    // ETF look-through: a composition percentage, mid scenario only.
    at('IB-HK', 'MXUS', 1000000, { assetType: 'ETF' }),
    // T2 at IB-HK, and the SAME ticker at Webull further down. Two positions.
    at('IB-HK', 'GOOG', 100000),
    // T3.
    at('IB-HK', 'BRK.B', 200000),
    // T1.
    at('Schwab-HK', 'AVGO', 50000),
    // A leveraged ETF special case: min(2 x T2, 100%).
    at('Schwab-HK', 'METU', 40000, { assetType: 'ETF' }),
    // The same company as IB-HK's BRK.B, spelled differently by another
    // custodian. Identity, not the literal string, is what keeps them apart.
    at('Schwab-HK', 'BRK/B', 80000),
    // The literal duplicate symbol, in a different account.
    at('Webull', 'GOOG', 120000),
    // A delegated rule, matched on the identity the rule actually records.
    at('Webull', 'VST', 58820, { holdingId: '29098649', instrumentId: '1753523', venue: 'NYSE' }),
    at('Webull', 'BE', 64623, { holdingId: '29037698', instrumentId: '1893267', venue: 'NYSE' }),
    // An owner override.
    at('Webull', 'MRVL', 68088, { holdingId: '28987468', instrumentId: '28987468' }),
    // A first-seen ordinary stock no rule and no registry entry covers: AUTO.
    at('Webull', 'NEWAI', 12345, { firstSeen: true }),
    // And a non-stock nothing covers: excluded, with an enumerated reason, out
    // of the numerator and still inside the denominator.
    at('Webull', 'ODDETF', 9000, { assetType: 'ETF', firstSeen: true }),
  ];
}

// The denominator as a composition: one stable key, one label and one exact
// integer micro-USD amount per account. These keys are synthetic in the same way
// every market value here is synthetic; binding the production three-account set
// to the run's own source reports is the source adapter's job, not this
// fixture's, and the arithmetic below does not depend on which keys they are.
const denominator = () => ({ components: [
  { key: 'ib-hk', label: 'IB NAV', valueMicro: '5000000000000' },
  { key: 'schwab-hk', label: 'Schwab-HK', valueMicro: '700000000000' },
  { key: 'webull', label: 'Webull', valueMicro: '600000000000' },
] });

// The holdings table is the IB book alone — three rows here — while the risk
// universe above has twelve constituents across three custodians.
const holding = (symbol) => ({ symbol, market: 'NASDAQ', quantity: 1, price: 100,
  priceCurrency: 'USD', marketValueUsd: 100, changePct: null, changeAsOfHkt: null,
  quoteStatus: 'unavailable' });
const card = (title) => ({ title, asOfHkt: hktStamp, lines: ['合成三账户测试；不是金融数据。'],
  columns: ['项目', '状态'], rows: [['合成项', '仅测试']] });
const view = () => ({ schemaVersion: 1, edition: 'am', dataDate, asOfHkt: hktStamp,
  marketContext: '合成三账户测试', alerts: [{ level: 'warning', text: '合成测试，不得发布。' }],
  summary: ['合成摘要一。', '合成摘要二。', '合成摘要三。'],
  kpis: [{ label: '合成 NAV', value: 300, format: 'usd', asOfHkt: hktStamp, note: '合成数值' },
    { label: '合成现金', value: null, format: 'usd', asOfHkt: hktStamp, note: '缺失不填零' },
    { label: '合成比例', value: 1, format: 'percent', asOfHkt: hktStamp, note: '仅测试' }],
  holdings: { status: 'ok', asOfHkt: hktStamp, authoritativeValueUsd: 300, note: '合成持仓。',
    rows: [holding('MXUS'), holding('GOOG'), holding('BRK.B')] },
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

const build = () => prepareReport(view(), evidence(),
  { ...context, riskConstituents: universe(), riskDenominator: denominator() });

const runGuard = (t, html) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-ai-risk-3acct-'));
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
const manifestOf = (html) => JSON.parse(html.match(
  /<template id="xuan-ib-ai-tier-records-v1" type="application\/json">([\s\S]*?)<\/template>/)[1]);
const riskPane = (html) => html.match(/<div class="pane p2">([\s\S]*?)(?=<div class="pane p3">)/)[1];

// ---------------------------------------------------------------------------
// Gap A: identity, not ticker, and a risk universe of its own.
// ---------------------------------------------------------------------------

test('a duplicate symbol across two custodians flows through prepare, render and the real guard', t => {
  const built = build();
  // Reaching here means `prepareReport` ran the actual trusted guard over the
  // actual candidate bytes and it accepted them. Under the symbol-keyed rule
  // this fixture could not be built at all: it threw DUPLICATE_CONSTITUENT.
  assert.equal(built.result.status, 'prepared-not-published');
  assert.equal(runGuard(t, built.html).status, 0, 'the untouched three-account candidate must pass');

  const manifest = manifestOf(built.html);
  assert.equal(manifest.length, 12);

  // Both GOOG positions survive, as two records with two identities, two
  // custodians and two independent contributions.
  const googs = manifest.filter(entry => entry.symbol === 'GOOG');
  assert.equal(googs.length, 2);
  assert.deepEqual(googs.map(entry => entry.custodian).sort(), ['IB-HK', 'Webull']);
  assert.equal(new Set(googs.map(entry => entry.key)).size, 2);
  assert.equal(googs.every(entry => entry.status === 'classified'), true);

  // The same company under two spellings stays two constituents too.
  assert.deepEqual(manifest.filter(entry => ['BRK.B', 'BRK/B'].includes(entry.symbol))
    .map(entry => entry.custodian).sort(), ['IB-HK', 'Schwab-HK']);

  // The risk universe is its own, and is NOT the holdings table's. Twelve
  // constituents across three accounts; three IB rows in the holdings table.
  const pane = riskPane(built.html);
  assert.match(pane, /data-ai-risk-universe-v1="12"/);
  assert.match(built.html, /data-holdings-universe-v1="3"/);
  for (const entry of manifest) {
    assert.ok(pane.includes(`data-ai-risk-constituent="${entry.key}"`),
      `${entry.symbol} at ${entry.custodian} must be declared in the risk universe`);
  }
});

test('every resolution path is reached, and each is recorded in its own namespace', () => {
  const constituents = universe();
  const coverage = buildAiTierCoverage(constituents);
  const basis = Object.fromEntries(coverage.resolved.map((item, index) =>
    [`${constituents[index].custodian}:${constituents[index].symbol}`, item.basis]));
  assert.equal(basis['IB-HK:MXUS'], 'registry');
  assert.equal(basis['Schwab-HK:METU'], 'registry');
  assert.equal(basis['Webull:VST'], 'delegated');
  assert.equal(basis['Webull:BE'], 'delegated');
  assert.equal(basis['Webull:MRVL'], 'owner-override');
  assert.equal(basis['Webull:NEWAI'], 'auto');
  assert.equal(basis['Webull:ODDETF'], 'excluded');

  const namespaces = Object.fromEntries(coverage.entries.map(entry =>
    [`${entry.custodian}:${entry.symbol}`, entry.namespace]));
  assert.equal(namespaces['IB-HK:GOOG'], 'REG');
  assert.equal(namespaces['Webull:VST'], 'DELEG');
  assert.equal(namespaces['Webull:MRVL'], 'WU');
  assert.equal(namespaces['Webull:NEWAI'], 'AUTO');

  // The excluded one is named, with an enumerated reason, and stays in the
  // denominator rather than disappearing.
  const odd = coverage.entries.find(entry => entry.symbol === 'ODDETF');
  assert.equal(odd.status, 'excluded');
  assert.equal(odd.reason, AUTO_EXCLUSION_REASONS.ASSET_TYPE_NOT_ORDINARY_STOCK);
  assert.equal(coverage.coverage.classified, 11);
  assert.equal(coverage.coverage.excluded, 1);
});

// ---------------------------------------------------------------------------
// Gap B: the number follows from the classification, and the gate recomputes it.
// ---------------------------------------------------------------------------

test('the numerator is computed from the approved coefficients, not from a supplied total', () => {
  const constituents = universe();
  const coverage = buildAiTierCoverage(constituents);
  const pressure = computeAiPressure(constituents, coverage, { denominator: denominator() });
  const row = (symbol, custodian) => pressure.rows.find(item =>
    item.symbol === symbol && item.custodian === custodian);

  // Each coefficient is the one the approved rule or the transcribed registry
  // records, applied to the caller's own source-bound market value.
  assert.equal(row('MXUS', 'IB-HK').coefficients.mid, 0.2503);
  assert.equal(row('MXUS', 'IB-HK').contributions.mid, 250300);
  assert.equal(row('GOOG', 'IB-HK').coefficients.mid, 0.55);
  assert.equal(row('GOOG', 'IB-HK').contributions.mid, 55000);
  // The duplicate ticker contributes independently, on its own market value.
  assert.equal(row('GOOG', 'Webull').contributions.mid, 66000);
  assert.equal(row('BRK.B', 'IB-HK').contributions.mid, 10000);
  assert.equal(row('BRK/B', 'Schwab-HK').contributions.mid, 4000);
  assert.equal(row('AVGO', 'Schwab-HK').contributions.mid, 40000);
  // min(2 x 55%, 100%) = 100%, exactly as the published report states it.
  assert.equal(row('METU', 'Schwab-HK').coefficients.mid, 1);
  assert.equal(row('METU', 'Schwab-HK').contributions.mid, 40000);
  // An AUTO position is a real classification and really contributes.
  assert.equal(row('NEWAI', 'Webull').coefficients.mid, 0.8);
  assert.equal(row('NEWAI', 'Webull').contributions.mid, 9876);
  // The excluded one contributes nothing and says why — and the denominator
  // still contains its account.
  assert.equal(row('ODDETF', 'Webull').contributions.mid, 0);
  assert.equal(row('ODDETF', 'Webull').status, 'excluded');

  // The published VST scenario figures, reproduced exactly from the approved
  // rule rather than retyped: 低/高情景 $35,292 / $58,820, mid $47,056.
  assert.deepEqual(row('VST', 'Webull').contributions, { low: 35292, mid: 47056, high: 58820 });

  // The total is the sum of the rows, and the ratio follows from the total.
  const expected = pressure.rows.reduce((sum, item) => sum + item.contributions.mid, 0);
  assert.equal(pressure.numeratorUsd, expected);
  assert.equal(pressure.denominatorUsd, 6300000);
  // The ratio is held as an exact rational of the integer accumulators rather
  // than as a re-division of the rounded display figures, so it can differ from
  // a float sum in the last bit — in the accurate direction.
  assert.ok(Math.abs(pressure.ratio - expected / 6300000) < 1e-15);

  // An ETF look-through has no low or high case anywhere in the approved
  // material, so those scenarios are unavailable and named — never the mid case
  // repeated, and never zero.
  assert.equal(pressure.scenarios.mid.available, true);
  assert.equal(pressure.scenarios.low.available, false);
  assert.equal(pressure.scenarios.high.available, false);
  assert.deepEqual(pressure.scenarios.low.unavailableFor, [row('MXUS', 'IB-HK').key]);
});

test('a hand-tampered numerator, ratio, row or coefficient is caught by the real guard', t => {
  const built = build();
  assert.equal(runGuard(t, built.html).status, 0);
  const pane = riskPane(built.html);
  // Keys are read back from the page's own manifest rather than hardcoded, so
  // this test keeps testing the tampering rather than the fixture's numbering.
  const manifest = manifestOf(built.html);
  const keyOf = (symbol, custodian) => manifest.find(entry =>
    entry.symbol === symbol && entry.custodian === custodian).key;
  const fails = (html, pattern) => {
    const result = runGuard(t, html);
    assert.notEqual(result.status, 0, 'the tampered candidate must be refused');
    assert.match(result.stderr + result.stdout, pattern);
  };

  // 1. The summary total, edited on its own, exactly as a hand-written report
  //    would carry it. The rows still add up to the truth.
  const declared = Number(pane.match(/data-ai-numerator-cents="(\d+)"/)[1]);
  fails(built.html.replace(`data-ai-numerator-cents="${declared}"`,
    `data-ai-numerator-cents="${declared - 5_000_00}"`),
  /shows a numerator of \d+ cents but its own rows sum to \d+/);

  // 2. The displayed ratio, edited beside a correct table.
  const ratio = Number(pane.match(/data-ai-ratio-bp="(\d+)"/)[1]);
  fails(built.html.replace(`data-ai-ratio-bp="${ratio}"`, `data-ai-ratio-bp="${ratio - 500}"`),
    /ratio that does not follow from its own numerator and denominator/);

  // 3. A single displayed contribution silently inflated, with the exact
  //    unrounded product and the summary both left alone.
  const goog = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('GOOG', 'IB-HK')}"[^<>]*>`))[0];
  fails(built.html.replace(goog, goog.replace(/data-ai-contribution-cents="\d+"/,
    'data-ai-contribution-cents="9999999"')),
  /is not its own unrounded value rounded to cents/);

  // 3b. And the exact product moved instead, which is the figure the numerator
  //     is actually summed from.
  fails(built.html.replace(goog, goog.replace(/data-ai-contribution-mbp="\d+"/,
    'data-ai-contribution-mbp="9999999999999"')),
  /is not its market value times its own coefficient/);

  // 4. A coefficient quietly raised, with its own contribution kept consistent
  //    so the row's arithmetic still closes. The total no longer does — and the
  //    coefficient itself is refused against the approval it claims to be.
  const brk = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('BRK.B', 'IB-HK').replace('.', '\\.')}"[^<>]*>`))[0];
  fails(built.html.replace(brk, brk
    .replace('data-ai-coefficient-bp="500"', 'data-ai-coefficient-bp="8000"')
    .replace(/data-ai-contribution-mbp="\d+"/, 'data-ai-contribution-mbp="160000000000000"')
    .replace(/data-ai-contribution-cents="\d+"/, 'data-ai-contribution-cents="16000000"')),
  /displays a coefficient of 8000 basis points, but .* records 500/);

  // 5. A whole constituent dropped from the table while it stays classified in
  //    the manifest — the 2026-09-11 defect itself, stated as arithmetic.
  const webullGoogKey = keyOf('GOOG', 'Webull');
  const webullGoog = built.html.match(new RegExp(`<tr data-ai-risk-row="${webullGoogKey}"[\\s\\S]*?</tr>`))[0];
  fails(built.html.replace(webullGoog, ''),
    new RegExp(`${webullGoogKey} carries an AI tier classified record but contributes no row`));

  // 6. The fabricated merge: the two GOOG rows collapsed into one, as a
  //    symbol-keyed pipeline would have produced. The manifest still names both.
  const ibGoog = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('GOOG', 'IB-HK')}"[\\s\\S]*?</tr>`))[0];
  fails(built.html.replace(webullGoog, '').replace(ibGoog,
    ibGoog.replace(/data-ai-market-value-micro="\d+"/, 'data-ai-market-value-micro="220000000000"')
      .replace(/data-ai-market-value-cents="\d+"/, 'data-ai-market-value-cents="22000000"')
      .replace(/data-ai-contribution-mbp="\d+"/, 'data-ai-contribution-mbp="1210000000000000"')
      .replace(/data-ai-contribution-cents="\d+"/, 'data-ai-contribution-cents="12100000"')),
  /carries an AI tier classified record but contributes no row/);

  // 6b. A market value whose two published forms disagree — the micro-USD the
  //     arithmetic uses against the cents the reader sees.
  fails(built.html.replace(ibGoog, ibGoog.replace(/data-ai-market-value-cents="\d+"/,
    'data-ai-market-value-cents="22000000"')),
  /shows a market value in cents that is not its own micro-USD value/);

  // 7. An excluded row given a contribution, which is the same understatement
  //    running the other way.
  const odd = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('ODDETF', 'Webull')}"[^<>]*>`))[0];
  fails(built.html.replace(odd, odd.replace('data-ai-contribution-cents="0"',
    'data-ai-contribution-cents="720000"')),
  /is excluded but claims a contribution/);

  // 8. The headline KPI, edited on its own. It lives outside the risk pane and
  //    on the page this repair came from it was authored separately from the
  //    table, so the two could disagree with nothing to notice.
  const kpi = built.html.match(/<div class="kpi" data-ai-pressure-kpi-v1[^<>]*>/)[0];
  fails(built.html.replace(kpi, kpi.replace(/data-ai-kpi-ratio-bp="\d+"/, 'data-ai-kpi-ratio-bp="1"')),
    /KPI disagrees with the table it summarises/);
  fails(built.html.replace(kpi, kpi.replace(/data-ai-kpi-numerator-cents="\d+"/,
    'data-ai-kpi-numerator-cents="1"')), /KPI disagrees with the table it summarises/);
  // 9. And removing it entirely is not an escape either.
  fails(built.html.replace(/<div class="kpi" data-ai-pressure-kpi-v1[\s\S]*?<\/div><\/div>/, ''),
    /requires exactly one headline KPI derived from it/);
});

// ---------------------------------------------------------------------------
// Gap C: the coherent tamper. Every check above compares the page against
// itself, so a candidate that moves a coefficient AND re-derives the row, the
// total, the ratio and the headline tile from it produces a completely
// self-consistent page. Until the gate re-resolved the coefficient from the
// trusted approvals, that page passed.
// ---------------------------------------------------------------------------

// Rewrite one row's coefficient and then re-derive, from that new coefficient,
// every other figure the page publishes — the row's exact product, the row's
// displayed cents, the summary's unrounded numerator, the summary's cents, the
// ratio, and all three of the tile's numbers. The result is internally perfect.
const coherentlyRetuned = (html, key, newBp) => {
  const attribute = (tag, name) => BigInt(tag.match(new RegExp(`\\b${name}="(\\d+)"`))[1]);
  const round = (value) => (value + 50_000_000n) / 100_000_000n;
  const rowTag = html.match(new RegExp(`<tr data-ai-risk-row="${key}"[^<>]*>`))[0];
  const summaryTag = html.match(/<tr data-ai-pressure-v1="1"[^<>]*>/)[0];
  const kpiTag = html.match(/<div class="kpi" data-ai-pressure-kpi-v1[^<>]*>/)[0];

  const valueMicro = attribute(rowTag, 'data-ai-market-value-micro');
  const previous = attribute(rowTag, 'data-ai-contribution-mbp');
  const replacement = valueMicro * newBp;
  const numerator = attribute(summaryTag, 'data-ai-numerator-mbp') - previous + replacement;
  const denominatorMicroBasis = attribute(summaryTag, 'data-ai-denominator-micro') * 10_000n;
  const ratio = (numerator * 1_000_000n + denominatorMicroBasis / 2n) / denominatorMicroBasis;

  return html
    .replace(rowTag, rowTag
      .replace(/data-ai-coefficient-bp="\d+"/, `data-ai-coefficient-bp="${newBp}"`)
      .replace(/data-ai-contribution-mbp="\d+"/, `data-ai-contribution-mbp="${replacement}"`)
      .replace(/data-ai-contribution-cents="\d+"/, `data-ai-contribution-cents="${round(replacement)}"`))
    .replace(summaryTag, summaryTag
      .replace(/data-ai-numerator-mbp="\d+"/, `data-ai-numerator-mbp="${numerator}"`)
      .replace(/data-ai-numerator-cents="\d+"/, `data-ai-numerator-cents="${round(numerator)}"`)
      .replace(/data-ai-ratio-bp="\d+"/, `data-ai-ratio-bp="${ratio}"`))
    .replace(kpiTag, kpiTag
      .replace(/data-ai-kpi-numerator-mbp="\d+"/, `data-ai-kpi-numerator-mbp="${numerator}"`)
      .replace(/data-ai-kpi-numerator-cents="\d+"/, `data-ai-kpi-numerator-cents="${round(numerator)}"`)
      .replace(/data-ai-kpi-ratio-bp="\d+"/, `data-ai-kpi-ratio-bp="${ratio}"`));
};

test('a coefficient raised coherently across row, total, ratio and KPI is still refused', t => {
  const built = build();
  assert.equal(runGuard(t, built.html).status, 0);
  const manifest = manifestOf(built.html);
  const keyOf = (symbol, custodian) => manifest.find(entry =>
    entry.symbol === symbol && entry.custodian === custodian).key;
  const fails = (html, pattern) => {
    const result = runGuard(t, html);
    assert.notEqual(result.status, 0, 'a self-consistent page with an unapproved coefficient must be refused');
    assert.match(result.stderr + result.stdout, pattern);
  };

  // A `REG` assignment. The old check proved only that the record id existed in
  // the trusted registry, never that the displayed coefficient was that rule's.
  const retunedReg = coherentlyRetuned(built.html, keyOf('BRK.B', 'IB-HK'), 8000n);
  // The page really is internally consistent: nothing in it disagrees with
  // anything else in it.
  assert.match(retunedReg, /data-ai-coefficient-bp="8000"/);
  fails(retunedReg, /displays a coefficient of 8000 basis points, but REG-\S+ records 500/);

  // A `DELEG` approval, where the old check tested only the id's prefix.
  fails(coherentlyRetuned(built.html, keyOf('VST', 'Webull'), 10_000n),
    /displays a coefficient of 10000 basis points, but DELEG-\S+ records 8000/);

  // An owner `WU` selection.
  fails(coherentlyRetuned(built.html, keyOf('MRVL', 'Webull'), 4000n),
    /displays a coefficient of 4000 basis points, but WU-\S+ records 8000/);

  // And an `AUTO` record, whose id is itself a policy revision and an identity.
  fails(coherentlyRetuned(built.html, keyOf('NEWAI', 'Webull'), 10_000n),
    /displays a coefficient of 10000 basis points, but AUTO:\S+ records 8000/);

  // Lowering one is refused in exactly the same way: this is a binding to the
  // approval, not a one-sided ceiling.
  fails(coherentlyRetuned(built.html, keyOf('GOOG', 'Webull'), 100n),
    /displays a coefficient of 100 basis points, but \S+ records 5500/);
});

// ---------------------------------------------------------------------------
// Gap D: the denominator, which used to be a single typed total.
// ---------------------------------------------------------------------------

test('the denominator is re-added from its own published components', t => {
  const built = build();
  const composition = built.html.match(
    /<template id="xuan-ib-ai-denominator-v1" type="application\/json">([\s\S]*?)<\/template>/);
  const components = JSON.parse(composition[1]);
  const fails = (html, pattern) => {
    const result = runGuard(t, html);
    assert.notEqual(result.status, 0, 'the tampered denominator must be refused');
    assert.match(result.stderr + result.stdout, pattern);
  };
  const withComponents = (next) => built.html.replace(composition[1], JSON.stringify(next));

  // Each account is named once, by a stable key, with its own exact integer
  // micro-USD amount, and the three add up to the total the table divides by.
  assert.deepEqual(components.map(item => item.key), ['ib-hk', 'schwab-hk', 'webull']);
  assert.deepEqual(components.map(item => item.valueMicro),
    ['5000000000000', '700000000000', '600000000000']);
  assert.match(built.html, /data-ai-denominator-v1="3"/);

  // A dropped account understates the denominator and overstates the published
  // ratio. Before the composition existed there was nothing to notice it with.
  fails(withComponents(components.filter(item => item.key !== 'webull')),
    /declares 3 components but names 2/);
  // ...including when the declared count is moved to match.
  fails(withComponents(components.filter(item => item.key !== 'webull'))
    .replace('data-ai-denominator-v1="3"', 'data-ai-denominator-v1="2"'),
  /must contain exactly ib-hk, schwab-hk, webull/);

  // A repeated account double-counts one book and understates the ratio.
  fails(withComponents([...components, components[2]])
    .replace('data-ai-denominator-v1="3"', 'data-ai-denominator-v1="4"'),
  /names the component webull more than once/);

  // Even a zero-valued invented component is outside the approved scope. Its
  // sum is coherent, so only an exact account-set guard can catch it.
  fails(withComponents([...components,
    { key: 'invented', label: 'Invented', valueMicro: '0' }])
    .replace('data-ai-denominator-v1="3"', 'data-ai-denominator-v1="4"'),
  /must contain exactly ib-hk, schwab-hk, webull/);

  // One component quietly changed, with the total left alone.
  fails(withComponents(components.map(item =>
    item.key === 'schwab-hk' ? { ...item, valueMicro: '900000000000' } : item)),
  /components sum to 6500000000000 micro-USD but the table uses 6300000000000/);

  // A component finer than a cent, which no published figure could be shown as.
  fails(withComponents(components.map(item =>
    item.key === 'webull' ? { ...item, valueMicro: '600000000001' } : item)),
  /component webull is not verified to the cent/);

  // A component with no stable key, or with fields nothing verifies.
  fails(withComponents(components.map(item =>
    item.key === 'ib-hk' ? { ...item, key: 'IB HK' } : item)),
  /does not carry a stable component key/);
  fails(withComponents(components.map(item =>
    item.key === 'ib-hk' ? { ...item, note: '手写' } : item)),
  /component has missing or unknown fields/);

  // And the composition cannot simply be removed.
  fails(built.html.replace(composition[0], ''),
    /requires exactly one xuan-ib-ai-denominator-v1 composition template/);
});

test('a coherent denominator tamper is caught by the components it does not change', t => {
  const built = build();
  const summaryTag = built.html.match(/<tr data-ai-pressure-v1="1"[^<>]*>/)[0];
  const kpiTag = built.html.match(/<div class="kpi" data-ai-pressure-kpi-v1[^<>]*>/)[0];
  const paragraph = built.html.match(/<p data-ai-denominator-v1="3"[^<>]*>/)[0];
  const numerator = BigInt(summaryTag.match(/data-ai-numerator-mbp="(\d+)"/)[1]);

  // Shrinking the denominator inflates the published ratio. Here it is moved
  // everywhere it appears — the summary row, the visible composition line, the
  // headline tile — and the ratio is re-derived from the new value, so the page
  // agrees with itself in every figure it shows. That is exactly the tamper the
  // old single-total form had no answer to.
  const movedMicro = 5_000_000_000_000n;
  const movedCents = movedMicro / 10_000n;
  const movedRatio = (numerator * 1_000_000n + movedMicro * 10_000n / 2n) / (movedMicro * 10_000n);
  const tampered = built.html
    .replace(summaryTag, summaryTag
      .replace(/data-ai-denominator-micro="\d+"/, `data-ai-denominator-micro="${movedMicro}"`)
      .replace(/data-ai-denominator-cents="\d+"/, `data-ai-denominator-cents="${movedCents}"`)
      .replace(/data-ai-ratio-bp="\d+"/, `data-ai-ratio-bp="${movedRatio}"`))
    .replace(paragraph, paragraph
      .replace(/data-ai-denominator-total-micro="\d+"/, `data-ai-denominator-total-micro="${movedMicro}"`)
      .replace(/data-ai-denominator-total-cents="\d+"/, `data-ai-denominator-total-cents="${movedCents}"`))
    .replace(kpiTag, kpiTag
      .replace(/data-ai-kpi-denominator-micro="\d+"/, `data-ai-kpi-denominator-micro="${movedMicro}"`)
      .replace(/data-ai-kpi-denominator-cents="\d+"/, `data-ai-kpi-denominator-cents="${movedCents}"`)
      .replace(/data-ai-kpi-ratio-bp="\d+"/, `data-ai-kpi-ratio-bp="${movedRatio}"`));

  const result = runGuard(t, tampered);
  assert.notEqual(result.status, 0, 'a denominator moved consistently everywhere must still be refused');
  assert.match(result.stderr + result.stdout,
    /components sum to 6300000000000 micro-USD but the table uses 5000000000000/);
});

test('an ordinary report cannot keep the manifest while omitting the pressure computation', t => {
  const built = build();
  const stripped = built.html
    .replace(/<template id="xuan-ib-ai-denominator-v1"[\s\S]*?<\/template>/, '')
    .replace(/data-ai-pressure-v1/g, 'data-ai-pressure-disabled')
    .replace(/data-ai-risk-row/g, 'data-ai-risk-row-disabled')
    .replace(/data-ai-pressure-kpi-v1/g, 'data-ai-pressure-kpi-disabled')
    .replace(/data-ai-denominator-v1/g, 'data-ai-denominator-disabled');
  const result = runGuard(t, stripped);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout,
    /must publish its computed AI pressure table/);
});

test('the headline AI pressure KPI is derived, not accepted from the caller', () => {
  const built = build();
  // It carries the computation's own numbers, in machine-readable form.
  assert.match(built.html, /data-ai-pressure-kpi-v1="1"/);
  assert.match(built.html, /<div class="lab">AI 压力中情景<\/div>/);
  // Twelve constituents, one of them excluded, disclosed on the tile itself.
  assert.match(built.html, /1 项无可用系数未计入分子，仍在分母内/);

  // A caller that tries to author its own AI-pressure tile is refused rather
  // than rendered beside the derived one.
  const shadowed = view();
  shadowed.kpis[2] = { label: 'AI 压力中情景（不完整）', value: 22.75, format: 'percent',
    asOfHkt: hktStamp, note: '手写数值' };
  assert.throws(() => prepareReport(shadowed, evidence(),
    { ...context, riskConstituents: universe(), riskDenominator: denominator() }),
  /derived and must not also be supplied as a view KPI/);
});

test('a fabricated REG record is refused against the trusted registry', t => {
  const built = build();
  const manifest = manifestOf(built.html);
  const source = JSON.stringify(manifest);
  const fails = (entries, pattern) => {
    const result = runGuard(t, built.html.replace(source, JSON.stringify(entries)));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, pattern);
  };
  // A registry-looking id minted for an instrument the trusted registry does not
  // record would be a coefficient no approved document covers, presented as one
  // that is already approved.
  fails(manifest.map(entry => entry.symbol === 'NEWAI'
    ? { ...entry, namespace: 'REG', recordId: 'REG-ai-risk-tiers-v1-2026-09-11-Webull:NEWAI' }
    : entry), /claims a REG rule the trusted registry does not record/);
  // And a real instrument re-pointed at another rule's id is refused too.
  fails(manifest.map(entry => entry.symbol === 'GOOG' && entry.custodian === 'Webull'
    ? { ...entry, recordId: 'REG-SPECIAL-IREN-LADDER' }
    : entry), /is not the trusted registry's rule for GOOG at Webull/);
});

test('a report may not supply its own AI pressure card beside the derived one', () => {
  const shadowed = view();
  shadowed.risk = [{ ...card('AI 压力敞口 · §0-C（三账户）'),
    columns: ['账户 · 标的', '计入 $'], rows: [['合成', '$1']] }];
  assert.throws(() => prepareReport(shadowed, evidence(),
    { ...context, riskConstituents: universe(), riskDenominator: denominator() }),
  /derived and must not also be supplied as a risk card/);
});

// ---------------------------------------------------------------------------
// Nothing above changed a coefficient.
// ---------------------------------------------------------------------------

test('the existing delegated and override coefficients are untouched', () => {
  // The pinned outputs of the single supported reader, unchanged by this work.
  const vst = calculateDelegatedTier({ symbol: 'VST', custodian: 'Webull', venue: 'NYSE',
    instrumentName: 'Vistra Corp', portfolioId: '1350094', holdingId: '29098649',
    instrumentId: '1753523', currency: 'USD', marketValueUsd: 58820, valueDate: dataDate },
  { approvalId: 'DELEG-20260910-VST-T1' });
  assert.equal(vst.tier, 'T1');
  assert.deepEqual([vst.low, vst.mid, vst.high], [35292, 47056, 58820]);
  assert.equal(vst.notifyId, 'classification:1350094:29098649:DELEG-20260910-VST-T1');
  // And it still refuses an instrument it has no approved rule for.
  assert.throws(() => calculateDelegatedTier({ symbol: 'GOOG', portfolioId: '936247',
    holdingId: '1', instrumentId: '1', currency: 'USD', marketValueUsd: 1, valueDate: dataDate },
  { approvalId: 'DELEG-20260910-VST-T1' }), /IDENTITY_MISMATCH/);

  // The transcribed registry carries the three standard ladders exactly as the
  // owner-reviewed §0-C table records them, and invents nothing.
  const reg = readAiRiskRegistry();
  assert.deepEqual(reg.ladderFor('T1'), { low: 0.6, mid: 0.8, high: 1 });
  assert.deepEqual(reg.ladderFor('T2'), { low: 0.4, mid: 0.55, high: 0.7 });
  assert.deepEqual(reg.ladderFor('T3'), { low: 0, mid: 0.05, high: 0.1 });
  // The named exceptions keep their published shape.
  assert.deepEqual(reg.lookup('Webull', 'IREN').ladder, { low: 0.6, mid: 1, high: 1 });
  assert.equal(reg.lookup('Schwab-HK', 'TSEM').tier, 'T2');
  // A look-through percentage is a composition fact with no scenario ladder.
  assert.deepEqual(reg.lookup('IB-HK', 'CSPX').ladder, { low: null, mid: 0.2579, high: null });
  // Nothing the registry does not record is resolved by it.
  assert.equal(reg.lookup('IB-HK', 'NOTREAL'), null);
  assert.equal(reg.lookup('Webull', 'AVGO'), null, 'a registry rule is bound to its own custodian');
});
