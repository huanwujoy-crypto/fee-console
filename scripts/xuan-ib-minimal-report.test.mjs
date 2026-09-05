import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMinimalReport } from './xuan-ib-minimal-report.mjs';
import { fingerprint, APPROVED_IB_ACCOUNT_ID, IB_ENDPOINTS } from './xuan-ib-run-manifest.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { renderReport, reportHtmlBlob, validateReportView } from './xuan-ib-report-view.mjs';
import { inactiveAssociationSnapshot } from './xuan-ib-association-test-fixture.mjs';
import { prepareReport } from './xuan-ib-report-prepare.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import { ETF_TAB_CSS_V1, ETF_TAB_LABEL_V1, ETF_TAB_RADIO_V1 } from './xuan-ib-etf-pane.mjs';
import { TREND_METHOD, simulateEtfTrend, projectOpenEtfTrend } from './xuan-ib-etf-trend.mjs';
import { renderEtfSummaryTemplate } from './xuan-ib-etf-summary-transport.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url), 'utf8'));
const policy = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-policy-v2.json', import.meta.url), 'utf8'));
// Reuse the small synthetic state/summary shape used by handover-guard and
// ETF transport tests. Unit history does not follow the mutable latest report.
const fixedState = { schemaVersion: 1, interaction: 'enabled', decisions: [
  { decisionId: 'D-20260901-SYNTH-PENDING', status: 'awaiting_user' },
  { decisionId: 'D-20260901-SYNTH-ACCEPTED', status: 'accepted' },
], receipts: [{ receiptId: 'R-20260901-100000-A1B2C3D4', decisionId: 'D-20260901-SYNTH-ACCEPTED',
  action: 'accepted', responseToSourceSha: '2'.repeat(40), responseToHtmlBlob: '3'.repeat(40),
  recordedAtHkt: '2026-09-01T10:00:00+08:00', publicSummary: '合成历史意见；只记录，不执行。' }] };
const fixedRecommendations = ['合成建议甲：只观察。', '合成建议乙：已记录。'];
const fixedCards = fixedState.decisions.map((item, index) => {
  const status = item.status === 'accepted' ? '已决定 / 待落实' : '待 Wu 审核';
  return `<details id="${item.decisionId}" data-decision-id="${item.decisionId}" data-decision-status="${item.status}"><summary>${index + 1} · 合成事项 ${index + 1}<span class="rt">${status}</span></summary><div class="dbody"><p><b class="lab">Claude 意见：</b>${fixedRecommendations[index]}</p><p><b class="lab">状态：</b>${status}（<code>${item.status}</code>）</p></div></details>`;
}).join('');
const fixedSummary = renderEtfSummaryTemplate(projectOpenEtfTrend(simulateEtfTrend({
  methodId: TREND_METHOD, startDate: '2020-09-01', frozenDate: '2020-09-04', initialUsd: 1_000_000,
  reserveUsd: 240_000, days: [{ date: '2020-09-01', actualUsd: 1_000_000, actualComplete: true,
    flowsComplete: true, flows: [], sourceRef: 'SYNTHETIC-PRIVATE', quotes: Object.fromEntries(
      ['CSPX', 'EXUS', 'EIMI', 'USSC'].map(symbol => [symbol, { status: 'close', usd: 10, date: '2020-09-01', source: 'synthetic' }])) }],
})));
const previousHtml = `<!doctype html><html><head><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN-投资管理</title><style>${ETF_TAB_CSS_V1}</style></head><body><!-- xuan-ib-handover:v1 --><h1>XUAN-投资管理</h1><span class="date">2026-09-04 周五 · 早间版 · 合成历史，不得发布</span><div class="tabs">${['s1','s2','s3','s4'].map(id => `<input type="radio" name="sec" id="${id}">`).join('')}${ETF_TAB_RADIO_V1}<div class="tabbar"><label for="s1">概览</label><label for="s2">风险</label><label for="s3">配置</label><label for="s4" aria-label="待办 1 项">待办 <span class="dot" aria-hidden="true">1</span></label>${ETF_TAB_LABEL_V1}</div><div class="pane p1"></div><div class="pane p2"></div><div class="pane p3"></div><div class="pane p4">${fixedCards}</div><div class="pane p5">${renderPolicySection(policy)}${fixedSummary}</div></div><template id="xuan-ib-decision-state-v1" type="application/json">${JSON.stringify(fixedState)}</template></body></html>`;
const previousMeta = { schemaVersion: 1, sourceSha: '1'.repeat(40), sourceCommitEpoch: 1788480000,
  dataDate: '2026-09-04', htmlBlob: reportHtmlBlob(previousHtml) };
const priorTemplate = previousHtml.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/);
const priorState = parseDecisionJson(priorTemplate[1], 2_000_000);
const dataDate = '2026-09-05';
const now = Date.parse(`${dataDate}T02:10:00Z`);
const options = () => ({ registry, previousHtml, previousMeta, now });
const receipt = (raw, date = dataDate) => ({ raw, status: 'ok', startedAt: `${date}T02:00:00Z`,
  completedAt: `${date}T02:00:01Z`, retries: 0, rawFingerprint: fingerprint(raw) });
const position = (description, currency, value) => ({ contract_description: description,
  position: 2, market_price: value / 2, market_value: value, currency });
const balance = (currency, stockValue, exchangeRate = 1) => ({ currency, cash_balance: 30,
  settled_cash: 30, net_liquidation_value: 140, stock_market_value: stockValue,
  unrealized_pnl: 4, realized_pnl: 0, exchange_rate: exchangeRate });
const nativeOrder = (id, side, description, changes = {}) => ({ order_id: id,
  order_status: 'NEW', order_type: 'LIMIT', side, limit_price: '50.2500',
  total_shares_qty: '30.00', cum_shares_qty: '10.00', remaining_shares_qty: '20.00',
  primary_description: description, secondary_description: 'LIMIT native time-in-force text',
  order_time: '2026-09-01T03:14:15Z', ...changes });
function fixture({ date = dataDate, sourceSha = previousMeta.sourceSha } = {}) {
  const raw = {
    accountSummary: { account_id: APPROVED_IB_ACCOUNT_ID, currency: 'USD', net_liquidation: 140,
      total_cash_value: 30, stock_market_value: 555555, gross_position_value: 987654 },
    balances: { balances: [balance('BASE', 100), balance('USD', 80), balance('CAD', 20, 0.7)] },
    positions: { positions: [position('SYNTHETIC @ native', 'USD', 80), position('FOREIGN @ native', 'EUR', 20)] },
    orders: { orders: [] }, trades: { trades: [] },
  };
  return { edition: 'adhoc', dataDate: date, previousSourceSha: sourceSha,
    ib: Object.fromEntries(IB_ENDPOINTS.map(name => [name, receipt(raw[name], date)])),
    sharesight: registry.portfolios.filter(item => item.requiredEachReport).map(item => receipt({
      result: { mode: 'read_only', portfolio: { id: item.portfolioId, currency_code: 'USD' },
        data: { report: { portfolio_id: item.portfolioId, value: 999, end_date: '2026-08-24',
          currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } },
    }, date)),
  };
}
const recapture = (input, endpoint) => { input.ib[endpoint].rawFingerprint = fingerprint(input.ib[endpoint].raw); };

test('minimal view is deterministic, preserves raw receipts and validates the full required source set', () => {
  const input = fixture(), before = JSON.stringify(input);
  const first = buildMinimalReport(input, options()), second = buildMinimalReport(input, options());
  assert.deepEqual(first, second); assert.equal(JSON.stringify(input), before);
  assert.equal(validateReportView(first.view), first.view);
  assert.equal(first.evidence.sources.sharesight.length, 9);
  assert.equal(first.evidence.sources.ib.accountSummary.fingerprint, input.ib.accountSummary.rawFingerprint);
  assert.deepEqual(first.view.kpis.map(item => item.value), [140, 30, 100]);
  assert.equal(first.view.cashPlan.status, 'unavailable');
  assert.equal(first.view.risk[0].brief.state, 'unavailable');
  assert.equal(first.view.allocation[0].brief.state, 'unavailable');
});

test('authoritative stock_market_value comes only from unique balances BASE, never summary, currency-component sum or NAV minus cash', () => {
  const input = fixture(), view = buildMinimalReport(input, options()).view;
  assert.equal(view.holdings.authoritativeValueUsd, 100);
  assert.notEqual(view.holdings.authoritativeValueUsd, 140 - 30);
  assert.notEqual(view.holdings.authoritativeValueUsd, 987654);
  assert.notEqual(view.holdings.authoritativeValueUsd, 555555);
  assert.notEqual(view.holdings.authoritativeValueUsd, 100 + 80 + 20);
  for (const value of [undefined, null, -1, 'untrusted summary field', 999999]) {
    const changed = fixture();
    if (value === undefined) delete changed.ib.accountSummary.raw.stock_market_value;
    else changed.ib.accountSummary.raw.stock_market_value = value;
    recapture(changed, 'accountSummary');
    assert.equal(buildMinimalReport(changed, options()).view.kpis[2].value, 100);
  }
  for (const value of [undefined, null, -1, '100', Infinity, NaN]) {
    const changed = fixture();
    if (value === undefined) delete changed.ib.balances.raw.balances[0].stock_market_value;
    else changed.ib.balances.raw.balances[0].stock_market_value = value;
    if (Number.isFinite(value) || typeof value !== 'number') recapture(changed, 'balances');
    assert.throws(() => buildMinimalReport(changed, options()), /AUTHORITATIVE_STOCK_VALUE_REQUIRED|INVALID_BALANCE_NUMBER|UNSUPPORTED_BALANCE_SHAPE|non-finite/);
  }
  input.ib.balances.raw.balances[0].stock_market_value = 0; recapture(input, 'balances');
  assert.equal(buildMinimalReport(input, options()).view.kpis[2].value, 0);
});

test('BASE currency identity, numeric fields and exchange rate must be explicit and unambiguous', () => {
  for (const [edit, error] of [
    [input => { input.ib.balances.raw.balances.shift(); }, /BASE_BALANCE_REQUIRED/],
    [input => { input.ib.balances.raw.balances.push(balance('BASE', 100)); }, /BASE_BALANCE_AMBIGUOUS/],
    [input => { input.ib.balances.raw.balances[1].currency = 'usd'; }, /INVALID_BALANCE_CURRENCY/],
    [input => { input.ib.balances.raw.balances[0].currency = null; }, /INVALID_BALANCE_CURRENCY/],
    [input => { input.ib.balances.raw.balances[0].exchange_rate = 1.01; }, /BASE_EXCHANGE_RATE_NOT_ONE/],
    [input => { input.ib.balances.raw.balances[0].exchange_rate = '1'; }, /INVALID_BALANCE_NUMBER/],
    [input => { input.ib.balances.raw.balances[2].cash_balance = '30'; }, /INVALID_BALANCE_NUMBER/],
  ]) {
    const input = fixture(); edit(input); recapture(input, 'balances');
    assert.throws(() => buildMinimalReport(input, options()), error);
  }
});

test('stock aggregate and position rows retain their separate actual source times', () => {
  const input = fixture();
  input.ib.balances.startedAt = `${dataDate}T02:01:00Z`; input.ib.balances.completedAt = `${dataDate}T02:01:01Z`;
  input.ib.positions.startedAt = `${dataDate}T02:02:00Z`; input.ib.positions.completedAt = `${dataDate}T02:02:01Z`;
  const { view } = buildMinimalReport(input, options());
  assert.equal(view.kpis[0].asOfHkt, `${dataDate} 10:00 HKT`);
  assert.equal(view.kpis[2].asOfHkt, `${dataDate} 10:01 HKT`);
  assert.equal(view.holdings.asOfHkt, `${dataDate} 10:02 HKT`);
  assert.ok(view.holdings.note.includes(`余额表 BASE（${dataDate} 10:01 HKT）`));
  assert.ok(view.kpis[2].note.includes('不累加币种分项'));
});

test('exact native position labels and native currencies are not invented tickers, venues or USD conversions', () => {
  const view = buildMinimalReport(fixture(), options()).view;
  assert.equal(view.holdings.rows[0].symbol, 'SYNTHETIC @ native');
  assert.equal(view.holdings.rows[0].market, 'IB原始标识');
  assert.equal(view.holdings.rows[0].marketValueUsd, 80);
  assert.equal(view.holdings.rows[1].priceCurrency, 'EUR');
  assert.equal(view.holdings.rows[1].price, 10);
  assert.equal(view.holdings.rows[1].marketValueUsd, null);
  assert.match(view.holdings.note, /USD 行小计 \$80/);
  assert.match(view.holdings.note, /差额 \$20，尚未对账/);
  assert.match(view.holdings.note, /外币 1 行不换汇/);
  for (const row of view.holdings.rows) {
    assert.equal(row.changePct, null); assert.equal(row.changeAsOfHkt, null); assert.equal(row.quoteStatus, 'unavailable');
  }
});

test('raw labels are never truncated or invented to evade duplicate/length/display limits', () => {
  for (const [edit, expected] of [
    [x => x.ib.positions.raw.positions.push({ ...x.ib.positions.raw.positions[0] }), /DUPLICATE_POSITION_LABEL/],
    [x => { x.ib.positions.raw.positions[0].contract_description = 'S'.repeat(31); }, /POSITION_LABEL_TOO_LONG/],
    [x => { x.ib.positions.raw.positions = Array.from({ length: 201 }, (_, i) => position(`S${i}`, 'USD', 1)); }, /POSITIONS_DISPLAY_LIMIT/],
  ]) {
    const input = fixture(); edit(input); recapture(input, 'positions');
    assert.throws(() => buildMinimalReport(input, options()), expected);
  }
});

test('all historical decisions, recommendation bytes and original ABC summary survive rendering', () => {
  const { view } = buildMinimalReport(fixture(), options());
  assert.deepEqual(view.decisions.map(item => item.decisionId), priorState.decisions.map(item => item.decisionId));
  assert.ok(view.decisions.every(item => item.isNew === false && item.fact.includes('未重算')));
  const rendered = renderReport(view, { previousHtml, previousMeta, policy, associationSnapshot: inactiveAssociationSnapshot() });
  assert.ok(rendered.includes(priorTemplate[0]));
  assert.equal(priorState.decisions.length, 2);
  assert.equal(priorState.receipts.length, 1);
  assert.ok(rendered.includes(fixedSummary), 'the fixed original ABC template and dates must survive');
  for (const recommendation of fixedRecommendations) assert.ok(rendered.includes(recommendation));
  assert.ok(rendered.includes('本次未重算该事项'));
  assert.ok(!rendered.includes('IB 股票市值</div><div class="big num">$987,654'));
});

test('unverified previous pair, changed source and missing required source stop rather than reset history', () => {
  assert.throws(() => buildMinimalReport(fixture(), { ...options(), previousMeta: { ...previousMeta, htmlBlob: '0'.repeat(40) } }));
  const mismatch = fixture(); mismatch.previousSourceSha = 'a'.repeat(40);
  assert.throws(() => buildMinimalReport(mismatch, options()), /PREVIOUS_SOURCE_MISMATCH/);
  const altered = fixture(); altered.ib.accountSummary.raw.net_liquidation++;
  assert.throws(() => buildMinimalReport(altered, options()), /RAW_CHANGED_SINCE_CAPTURE/);
  const missing = fixture(); missing.sharesight.pop();
  assert.throws(() => buildMinimalReport(missing, options()));
});

test('unsupported nonempty orders cannot become an empty orders table', () => {
  const input = fixture(); input.ib.orders.raw.orders = [{ unknown_order_field: 'synthetic' }]; recapture(input, 'orders');
  assert.throws(() => buildMinimalReport(input, options()), /^Error: Minimal report: UNSUPPORTED_ORDER_SHAPE$/);
});

test('native LIMIT orders preserve original descriptions and decimal strings, group buys before sells without guessed price distances', () => {
  const input = fixture();
  input.ib.orders.raw.orders = [nativeOrder(987654321, 'SELL', 'SELL 30 native instrument A'),
    nativeOrder(987654322, 'BUY', 'BUY 30 native instrument B', { order_status: 'REPLACED', limit_price: '70.5000' }),
    nativeOrder(987654323, 'BUY', 'BUY 30 native instrument C', { limit_price: '10.0000' })];
  recapture(input, 'orders');
  const original = JSON.stringify(input);
  const { view, evidence } = buildMinimalReport(input, options());
  assert.deepEqual(view.rotation.columns, ['原始说明', '买卖', '限价', '数量', '状态']);
  assert.deepEqual(view.rotation.rows.map(row => row[1]), ['买入', '买入', '卖出']);
  assert.equal(view.rotation.rows[0][0], 'BUY 30 native instrument B\nLIMIT native time-in-force text');
  assert.equal(view.rotation.rows[1][0], 'BUY 30 native instrument C\nLIMIT native time-in-force text');
  assert.equal(view.rotation.rows[0][2], '70.5000（币种未返回）');
  assert.equal(view.rotation.rows[0][3], '总 30.00 / 已成交 10.00 / 剩余 20.00');
  assert.equal(view.rotation.rows[0][4], 'REPLACED');
  assert.equal(Object.hasOwn(view.rotation, 'orders'), false, 'no invented fields for structured order renderer');
  assert.ok(view.rotation.lines[1].includes('同侧保留原顺序'));
  assert.equal(JSON.stringify(input), original);
  assert.equal(evidence.sources.ib.orders.fingerprint, input.ib.orders.rawFingerprint);
  assert.ok(!JSON.stringify(view).includes('987654321'));
  assert.ok(!JSON.stringify(view).includes('2026-09-01T03:14:15Z'));
  const prepared = prepareReport(view, evidence, { previousHtml, previousMeta, policy, registry,
    associationSnapshot: inactiveAssociationSnapshot() });
  assert.equal(prepared.result.status, 'prepared-not-published');
  assert.ok(prepared.html.includes('70.5000（币种未返回）'));
  assert.ok(prepared.html.includes(priorTemplate[0]));
});

test('only observed native order enums and types are accepted, without coercing unknown fields', () => {
  for (const changes of [{ side: 'buy' }, { side: 'SHORT' }, { order_type: 'MARKET' },
    { order_status: 'CANCELLED' }, { order_id: '1' }, { order_time: 'yesterday' },
    { order_time: null }, { primary_description: '' }, { secondary_description: null }, { currency: 'USD' }]) {
    const input = fixture(); input.ib.orders.raw.orders = [nativeOrder(1, 'BUY', 'BUY 30 synthetic', changes)]; recapture(input, 'orders');
    assert.throws(() => buildMinimalReport(input, options()), /UNSUPPORTED_ORDER_SHAPE/);
  }
});

test('order numbers require finite nonnegative decimal strings and consistent total/filled/remaining quantities', () => {
  for (const value of ['1e2', '-1', '+1', '01', 'NaN', 'Infinity', '', ' 1', 1, null, '1000000000001']) {
    const input = fixture(); input.ib.orders.raw.orders = [nativeOrder(1, 'BUY', 'BUY 30 synthetic', { limit_price: value })]; recapture(input, 'orders');
    assert.throws(() => buildMinimalReport(input, options()), /INVALID_ORDER_NUMBER/);
  }
  for (const changes of [{ limit_price: '0' }, { total_shares_qty: '0' },
    { cum_shares_qty: '-1' }, { remaining_shares_qty: 'wrong' }]) {
    const input = fixture(); input.ib.orders.raw.orders = [nativeOrder(1, 'BUY', 'BUY 30 synthetic', changes)]; recapture(input, 'orders');
    assert.throws(() => buildMinimalReport(input, options()), /INVALID_ORDER_NUMBER/);
  }
  for (const changes of [{ remaining_shares_qty: '21' }, { cum_shares_qty: '31', remaining_shares_qty: '0' }]) {
    const input = fixture(); input.ib.orders.raw.orders = [nativeOrder(1, 'BUY', 'BUY 30 synthetic', changes)]; recapture(input, 'orders');
    assert.throws(() => buildMinimalReport(input, options()), /INCONSISTENT_ORDER_QUANTITIES/);
  }
  const floating = fixture(); floating.ib.orders.raw.orders = [nativeOrder(1, 'BUY', 'BUY fractional synthetic', {
    total_shares_qty: '0.3', cum_shares_qty: '0.1', remaining_shares_qty: '0.2' })]; recapture(floating, 'orders');
  assert.equal(buildMinimalReport(floating, options()).view.rotation.rows[0][3], '总 0.3 / 已成交 0.1 / 剩余 0.2');
});

test('overlong descriptions, duplicate source order IDs and too many rows stop rather than truncate or drop orders', () => {
  for (const [orders, error] of [
    [[nativeOrder(1, 'BUY', 'X'.repeat(150))], /ORDER_TEXT_TOO_LONG/],
    [[nativeOrder(1, 'BUY', 'BUY A'), nativeOrder(1, 'SELL', 'SELL B')], /DUPLICATE_ORDER_ID/],
    [Array.from({ length: 61 }, (_, i) => nativeOrder(i, 'BUY', `BUY ${i} synthetic`)), /ORDERS_DISPLAY_LIMIT/],
  ]) {
    const input = fixture(); input.ib.orders.raw.orders = orders; recapture(input, 'orders');
    assert.throws(() => buildMinimalReport(input, options()), error);
  }
});

test('a USD account summary, same-day real source receipts and adhoc scope are required', () => {
  const foreign = fixture(); foreign.ib.accountSummary.raw.currency = 'EUR'; recapture(foreign, 'accountSummary');
  assert.throws(() => buildMinimalReport(foreign, options()), /USD_ACCOUNT_SUMMARY_REQUIRED/);
  const stale = fixture(); stale.ib.positions.startedAt = '2026-08-24T02:00:00Z'; stale.ib.positions.completedAt = '2026-08-24T02:00:01Z';
  assert.throws(() => buildMinimalReport(stale, options()), /READ_DATE_MISMATCH/);
  assert.throws(() => buildMinimalReport(fixture(), { ...options(), now: Date.parse(`${dataDate}T01:59:59Z`) }), /INVALID_READ_WINDOW/);
  const scheduled = fixture(); scheduled.edition = 'pm';
  assert.throws(() => buildMinimalReport(scheduled, options()), /ADHOC_TRIAL_ONLY/);
});

test('nonempty trades are counted without pretending they are newly executed orders', () => {
  const input = fixture(); input.ib.trades.raw.trades = [{ synthetic: 'historical row' }]; recapture(input, 'trades');
  const view = buildMinimalReport(input, options()).view;
  assert.match(view.observations[0], /1 条.*未判定其中的新成交/);
});

test('private-looking native labels are rejected before they enter public display', () => {
  const input = fixture(); input.ib.positions.raw.positions[0].contract_description = 'Bearer SYNTHETIC'; recapture(input, 'positions');
  assert.throws(() => buildMinimalReport(input, options()), /private or external/);
});

test('native synthetic minimal result passes unchanged prepare and trusted guard without publishing', () => {
  const { view, evidence } = buildMinimalReport(fixture(), options());
  const result = prepareReport(view, evidence, { previousHtml, previousMeta, policy, registry,
    associationSnapshot: inactiveAssociationSnapshot() });
  assert.equal(result.result.status, 'prepared-not-published');
  assert.ok(result.html.includes(priorTemplate[0]));
  assert.ok(result.html.includes('精简试跑'));
});

test('current latest remains compatible as one separate synthetic-read smoke test', () => {
  const html = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url), 'utf8');
  const meta = JSON.parse(fs.readFileSync(new URL('../xuan-ib/latest.meta.json', import.meta.url), 'utf8'));
  const input = fixture({ date: meta.dataDate, sourceSha: meta.sourceSha });
  const { view, evidence } = buildMinimalReport(input, { registry, previousHtml: html, previousMeta: meta,
    now: Date.parse(`${meta.dataDate}T02:10:00Z`) });
  const result = prepareReport(view, evidence, { previousHtml: html, previousMeta: meta, policy, registry,
    associationSnapshot: inactiveAssociationSnapshot() });
  assert.equal(result.result.status, 'prepared-not-published');
});

test('failed positions and missing rows never become a successful empty holdings display', () => {
  const failed = fixture(); failed.ib.positions = receipt({ isError: true, error: 'SYNTHETIC_FAILURE' });
  failed.ib.positions.status = 'failed';
  assert.throws(() => buildMinimalReport(failed, options()));
  const empty = fixture(); empty.ib.positions.raw.positions = []; recapture(empty, 'positions');
  assert.throws(() => buildMinimalReport(empty, options()), /POSITIVE_STOCK_VALUE_WITHOUT_POSITIONS/);
  empty.ib.balances.raw.balances[0].stock_market_value = 0; recapture(empty, 'balances');
  assert.equal(buildMinimalReport(empty, options()).view.holdings.rows.length, 0);
});
