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

const denominator = () => ({ components: [
  { label: 'IB NAV', valueUsd: 5000000 },
  { label: 'Schwab-HK', valueUsd: 700000 },
  { label: 'Webull', valueUsd: 600000 },
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

  // 3. A single contribution silently inflated, with the summary left alone.
  const goog = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('GOOG', 'IB-HK')}"[^<>]*>`))[0];
  fails(built.html.replace(goog, goog.replace(/data-ai-contribution-cents="\d+"/,
    'data-ai-contribution-cents="9999999"')),
  /is not its market value times its own coefficient/);

  // 4. A coefficient quietly raised, with its own contribution kept consistent
  //    so the row's arithmetic still closes. The total no longer does.
  const brk = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('BRK.B', 'IB-HK').replace('.', '\\.')}"[^<>]*>`))[0];
  fails(built.html.replace(brk, brk
    .replace('data-ai-coefficient-bp="500"', 'data-ai-coefficient-bp="8000"')
    .replace(/data-ai-contribution-cents="\d+"/, 'data-ai-contribution-cents="16000000"')),
  /but its own rows sum to/);

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
    ibGoog.replace(/data-ai-market-value-cents="\d+"/, 'data-ai-market-value-cents="22000000"')
      .replace(/data-ai-contribution-cents="\d+"/, 'data-ai-contribution-cents="12100000"')),
  /carries an AI tier classified record but contributes no row/);

  // 7. An excluded row given a contribution, which is the same understatement
  //    running the other way.
  const odd = built.html.match(new RegExp(`<tr data-ai-risk-row="${keyOf('ODDETF', 'Webull')}"[^<>]*>`))[0];
  fails(built.html.replace(odd, odd.replace('data-ai-contribution-cents="0"',
    'data-ai-contribution-cents="720000"')),
  /is excluded but claims a contribution/);
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
