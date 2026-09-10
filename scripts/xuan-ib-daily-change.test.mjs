import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport, validateReportView } from './xuan-ib-report-view.mjs';
import { normalizeDailyChangeWindow, measurePositionSessionChange } from './xuan-ib-source-adapter.mjs';
import { buildDailyChangeColumn, applyDailyChangeColumn, canonicalCode, identityKey,
  UNAVAILABLE_REASONS, DAILY_CHANGE_METHODS } from './xuan-ib-daily-change.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousMeta = JSON.parse(fs.readFileSync(path.join(root, 'xuan-ib/latest.meta.json'), 'utf8'));
// Existing published history is read, never rewritten: the renderer needs the
// trusted previous page to carry decisions forward.
const previousHtml = fs.readFileSync(path.join(root, 'xuan-ib/latest.html'), 'utf8');
const priorState = JSON.parse(previousHtml
  .match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)[1]);
const policy = JSON.parse(fs.readFileSync(path.join(root, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
const renderContext = { previousHtml, previousMeta, policy };
const reportDate = previousMeta.dataDate;
const priorSession = new Date(Date.parse(`${reportDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const stamp = `${reportDate} 08:13 HKT`;

// Synthetic source payloads only. No real holdings, amounts or account data.
const windowRaw = (holdings, over = {}) => ({ result: { mode: 'read_only',
  portfolio: { id: 936247, currency_code: 'USD' },
  data: { report: { portfolio_id: 936247, value: 100, currency: { code: 'USD' },
    start_date: priorSession, end_date: priorSession, percentages_annualised: false,
    cash_accounts: [], holdings, ...over } } } });
const holding = (code, market, pct, ccyPct = 0, over = {}) => ({
  instrument: { code, market_code: market, id: 1000 + code.length },
  instrument_currency: { code: 'USD' }, instrument_price: 10,
  capital_gain_percent: pct, currency_gain_percent: ccyPct, ...over });
const build = (measurements, extra = {}) => buildDailyChangeColumn({
  method: 'window-v1', intendedSessionDate: priorSession, measurements, ...extra });
const reasonsOf = column => Object.fromEntries(column.rows.map(row => [row.key, row.reason]));

const card = title => ({ title, asOfHkt: stamp, lines: ['合成测试；不是实际报告或投资建议。'],
  columns: ['项目', '读数'], rows: [['合成项', '仅测试']] });
const viewWith = rows => ({ schemaVersion: 1, edition: 'am', dataDate: reportDate, asOfHkt: stamp,
  marketContext: '合成测试 · 非真实运行', alerts: [{ level: 'warning', text: '合成测试数据；不得发布。' }],
  summary: ['合成测试摘要一。', '合成测试摘要二。', '合成测试摘要三。'],
  kpis: [{ label: '测试 NAV', value: 100, format: 'usd', asOfHkt: stamp, note: '合成数值' },
    { label: '测试现金', value: null, format: 'usd', asOfHkt: stamp, note: '缺失不填零' },
    { label: '测试比例', value: 10, format: 'percent', asOfHkt: stamp, note: '仅合成测试' }],
  holdings: { status: 'ok', asOfHkt: stamp, authoritativeValueUsd: 100,
    note: '估值价与日涨跌来源分开。合成测试。', rows },
  risk: [card('② 风险')], allocation: [card('④ 配置')], rotation: card('换仓'), events: card('日历未查询'),
  decisions: priorState.decisions.map(item => ({ decisionId: item.decisionId, asOfHkt: stamp,
    fact: '只验证当前事实显示，不改变历史意见。', isNew: false })),
  observations: ['合成测试观察'],
  notes: ['版次与时点：合成测试。', '数据与口径：不得当作金融数据。', '只读验证，不执行交易。'],
  cashPlan: { schemaVersion: 2, status: 'unavailable' } });
const viewRow = (symbol, market) => ({ symbol, market, quantity: 1, price: 10, priceCurrency: 'USD',
  marketValueUsd: 10, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' });

test('end to end: a source payload becomes a rendered column, and a suppressed row stays 未取得', () => {
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55), holding('VCN', 'TSE', -0.61, -0.18),
    holding('IVAI', 'LSE', 0)]);
  const measurements = normalizeDailyChangeWindow(raw, { date: priorSession,
    venuesComplete: ['NASDAQ', 'TSE', 'LSE'] });
  const column = build(measurements);
  assert.equal(column.coverage.available, 2);
  const rows = applyDailyChangeColumn(
    [viewRow('META', 'NASDAQ'), viewRow('VCN', 'TSE'), viewRow('IVAI', 'LSE')], column);
  const view = viewWith(rows);
  validateReportView(view);
  const html = renderReport(view, renderContext);
  // The measured rows reach the page as numbers, not as a placeholder.
  assert.match(html, /\+6\.55%/);
  assert.match(html, /-0\.61%/);
  assert.ok(html.includes(priorSession), 'the column is labelled with its own session date');
  // The indistinguishable row is still explicitly missing, and no row is 0.00%.
  assert.match(html, /未取得/);
  assert.ok(!/>0\.00%/.test(html), 'a zero is never rendered as a measured change');
  // The whole column is not missing: this is what the previous patch could not prove.
  assert.ok(!/涨跌数据待核验（3）/.test(html));
});

test('a column that cannot prove its session publishes nothing, including a winter PM before the open', () => {
  // A schedule pinned to a fixed UTC offset drifts an hour against New York
  // when daylight saving ends, so the run can start before the session exists.
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55), holding('GOOG', 'NASDAQ', -2.09)]);
  const unproven = normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: [] });
  const column = build(unproven);
  assert.equal(column.coverage.available, 0);
  assert.deepEqual(column.coverage.reasons, { [UNAVAILABLE_REASONS.SESSION]: 2 });
  // A row whose session date is not the reported one is refused as well.
  const wrongDay = build(normalizeDailyChangeWindow(
    windowRaw([holding('META', 'NASDAQ', 6.55)], { start_date: reportDate, end_date: reportDate }),
    { date: reportDate, venuesComplete: ['NASDAQ'] }));
  assert.equal(wrongDay.rows[0].reason, UNAVAILABLE_REASONS.SESSION);
});

test('venues prove their session one at a time, never as one portfolio-wide flag', () => {
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55), holding('CSPX', 'LSE', -0.74),
    holding('EQAC', 'SWX', -0.55)]);
  const column = build(normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NASDAQ'] }));
  assert.deepEqual(reasonsOf(column), { 'NASDAQ:META': null,
    'LSE:CSPX': UNAVAILABLE_REASONS.SESSION, 'SWX:EQAC': UNAVAILABLE_REASONS.SESSION });
});

test('an unloaded session cannot be smuggled past the check by one traded row', () => {
  const raw = windowRaw([holding('A', 'NASDAQ', 0), holding('B', 'NASDAQ', 0), holding('C', 'NASDAQ', 0)]);
  const measurements = normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NASDAQ'] });
  const column = build(measurements, { trades: [{ code: 'A', venue: 'NASDAQ' }] });
  assert.equal(column.coverage.available, 0);
  assert.deepEqual(reasonsOf(column), { 'NASDAQ:A': UNAVAILABLE_REASONS.TRADED,
    'NASDAQ:B': UNAVAILABLE_REASONS.FLAT_OR_STALE, 'NASDAQ:C': UNAVAILABLE_REASONS.FLAT_OR_STALE });
});

test('one stale venue among updated ones is caught per row, not by a portfolio total', () => {
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55), holding('GOOG', 'NASDAQ', -2.09),
    holding('EQAC', 'SWX', 0)]);
  const column = build(normalizeDailyChangeWindow(raw, { date: priorSession,
    venuesComplete: ['NASDAQ', 'SWX'] }));
  assert.equal(column.coverage.available, 2);
  assert.equal(reasonsOf(column)['SWX:EQAC'], UNAVAILABLE_REASONS.FLAT_OR_STALE);
});

test('aliases resolve to one venue-scoped key and a duplicate key publishes neither row', () => {
  assert.equal(canonicalCode('BRK B'), 'BRK.B');
  assert.equal(canonicalCode('BRK/B'), 'BRK.B');
  assert.equal(canonicalCode('brk-b'), 'BRK.B');
  assert.equal(identityKey({ venue: 'nyse', code: 'brk b' }), 'NYSE:BRK.B');
  assert.equal(identityKey({ venue: 'NYSE', code: '  ' }), null);
  // The books spell the same instrument differently; the trade still suppresses it.
  const raw = windowRaw([holding('BRK/B', 'NYSE', 0.18)]);
  const column = build(normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NYSE'] }),
    { trades: [{ code: 'BRK B', venue: 'NYSE' }] });
  assert.equal(column.rows[0].reason, UNAVAILABLE_REASONS.TRADED);
  // The same ticker on two venues stays two rows; a duplicate within one venue is refused.
  const cross = build(normalizeDailyChangeWindow(
    windowRaw([holding('CSPX', 'LSE', -0.74), holding('CSPX', 'SWX', 2)]),
    { date: priorSession, venuesComplete: ['LSE', 'SWX'] }));
  assert.deepEqual(cross.rows.map(row => [row.key, row.changePct]), [['LSE:CSPX', -0.74], ['SWX:CSPX', 2]]);
  const dupe = build(normalizeDailyChangeWindow(
    windowRaw([holding('CSPX', 'LSE', -0.74), holding('CSPX', 'LSE', 2)]),
    { date: priorSession, venuesComplete: ['LSE'] }));
  assert.deepEqual(dupe.rows.map(row => row.reason),
    [UNAVAILABLE_REASONS.AMBIGUOUS, UNAVAILABLE_REASONS.AMBIGUOUS]);
  // An unmergeable identity never inherits a neighbour's move.
  const merged = applyDailyChangeColumn([viewRow('CSPX', 'SWX')], cross);
  assert.equal(merged[0].changePct, 2);
  assert.equal(applyDailyChangeColumn([viewRow('CSPX', 'XETRA')], cross)[0].changePct, null);
});

test('a corporate action suppresses the row; the magnitude guard is only an outlier trap', () => {
  // An unadjusted 2-for-1 split reads as about -50% and sits inside any
  // plausible outlier bound, so the action itself must suppress the row.
  const raw = windowRaw([holding('SPLIT', 'NASDAQ', -50), holding('EXDIV', 'NASDAQ', -1.9),
    holding('OK', 'NASDAQ', 1.2)]);
  const measurements = normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NASDAQ'] });
  const column = build(measurements, { corporateActions: [
    { code: 'SPLIT', venue: 'NASDAQ' }, { code: 'EXDIV', venue: 'NASDAQ' }] });
  assert.deepEqual(reasonsOf(column), { 'NASDAQ:SPLIT': UNAVAILABLE_REASONS.CORPORATE_ACTION,
    'NASDAQ:EXDIV': UNAVAILABLE_REASONS.CORPORATE_ACTION, 'NASDAQ:OK': null });
  // Without the action list the same split is published: the guard alone is
  // not a corporate-action detector, which is why the caller must supply them.
  assert.equal(build(measurements).rows[0].changePct, -50);
  // The outlier bound still catches an impossible ratio.
  assert.equal(build(normalizeDailyChangeWindow(windowRaw([holding('WILD', 'NASDAQ', 250)]),
    { date: priorSession, venuesComplete: ['NASDAQ'] })).rows[0].reason, UNAVAILABLE_REASONS.OUTLIER);
});

test('one malformed row degrades alone and is counted, and events that cannot resolve are counted too', () => {
  const raw = windowRaw([holding('OK', 'NASDAQ', 1.5),
    holding('BAD', 'NASDAQ', 1.5, 0, { capital_gain_percent: 'x' }),
    holding('NOVENUE', null, 1.5)]);
  const column = build(normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NASDAQ'] }),
    { trades: [{ code: null, venue: 'NASDAQ' }] });
  assert.equal(column.coverage.available, 1);
  assert.equal(column.coverage.reasons[UNAVAILABLE_REASONS.MALFORMED], 1);
  assert.equal(column.coverage.reasons[UNAVAILABLE_REASONS.IDENTITY], 1);
  assert.equal(column.unresolvedEvents, 1);
});

test('window shape guards and the session-P&L measurement stay fail closed', () => {
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55)]);
  assert.throws(() => normalizeDailyChangeWindow(raw, { date: reportDate }), /NOT_SINGLE_DAY/);
  assert.throws(() => normalizeDailyChangeWindow(windowRaw([holding('META', 'NASDAQ', 6.55)],
    { percentages_annualised: true }), { date: priorSession }), /ANNUALISED/);
  for (const date of [null, '2026-9-9', 20260909]) {
    assert.throws(() => normalizeDailyChangeWindow(raw, { date }), /INVALID_DAILY_CHANGE_WINDOW/);
  }
  // base = marketValue - dailyPnl, verified against an independent close.
  const measured = measurePositionSessionChange({ marketValueNative: 64551.501465, dailyPnlNative: 3203.501465 },
    { code: 'META', venue: 'NASDAQ', sessionDate: priorSession, venuesComplete: ['NASDAQ'] });
  assert.equal(Number(measured.changePct.toFixed(4)), 5.2219);
  assert.equal(measured.sessionComplete, true);
  // Native currency needs no FX assumption.
  assert.equal(Number(measurePositionSessionChange({ marketValueNative: 75101.74656625, dailyPnlNative: -338.25343375 },
    { code: 'VCN', venue: 'TSE', sessionDate: priorSession }).changePct.toFixed(4)), -0.4484);
  // Missing or unusable inputs stay null, never zero.
  for (const position of [{ marketValueNative: 100, dailyPnlNative: null },
    { marketValueNative: 100, dailyPnlNative: 100 }, { marketValueNative: -100, dailyPnlNative: -10 }]) {
    assert.equal(measurePositionSessionChange(position, { code: 'A', venue: 'NASDAQ' }).changePct, null);
  }
  assert.throws(() => measurePositionSessionChange({ marketValueNative: '100', dailyPnlNative: 1 }), /INVALID_DAILY_CHANGE_INPUT/);
  for (const method of [null, 'made-up']) {
    assert.throws(() => buildDailyChangeColumn({ method, intendedSessionDate: priorSession, measurements: [] }), /UNKNOWN_METHOD/);
  }
  assert.ok(DAILY_CHANGE_METHODS.includes('session-pnl-v1'));
});

test('a published row must name its method and session, and a zero is never publishable', () => {
  const raw = windowRaw([holding('META', 'NASDAQ', 6.55)]);
  const column = build(normalizeDailyChangeWindow(raw, { date: priorSession, venuesComplete: ['NASDAQ'] }));
  const rows = applyDailyChangeColumn([viewRow('META', 'NASDAQ')], column);
  assert.equal(rows[0].changeMethod, 'window-v1');
  assert.equal(rows[0].changeSessionDate, priorSession);
  validateReportView(viewWith(rows));
  // Evidence that contradicts itself, or a bare zero, is refused.
  const badMethod = viewWith([{ ...rows[0], changeMethod: 'invented' }]);
  assert.throws(() => validateReportView(badMethod), /known method/);
  const badLabel = viewWith([{ ...rows[0], changeAsOfHkt: reportDate }]);
  assert.throws(() => validateReportView(badLabel), /name its own session/);
  const zero = viewWith([{ ...rows[0], changePct: 0 }]);
  assert.throws(() => validateReportView(zero), /zero change/);
  // A legacy row without measurement evidence stays renderable so already
  // published history is not retroactively invalidated; the builder can never
  // produce such a row, and a candidate using the column is refused above.
  const legacyZero = viewWith([{ ...viewRow('META', 'NASDAQ'), changePct: 0,
    changeAsOfHkt: priorSession, quoteStatus: 'ok' }]);
  validateReportView(legacyZero);
  // Evidence on a row that has no measurement is refused too.
  const orphan = viewWith([{ ...viewRow('META', 'NASDAQ'), changeMethod: 'window-v1', changeSessionDate: priorSession }]);
  assert.throws(() => validateReportView(orphan), /cannot carry measurement evidence/);
  // Passing no column leaves every row untouched.
  assert.deepEqual(applyDailyChangeColumn([viewRow('META', 'NASDAQ')], null)[0].changePct, null);
});
