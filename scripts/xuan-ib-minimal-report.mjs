// Deterministic first-trial view builder. No network, financial writes, policy
// activation, inferred account identity, FX conversion or publication. The
// source adapter still validates every required original response and receipt;
// the separate prepare/guard/promotion path remains mandatory.
import { buildSourceEvidence, normalizePositions, unwrapSource } from './xuan-ib-source-adapter.mjs';
import { IB_ENDPOINTS } from './xuan-ib-run-manifest.mjs';
import { buildDecisionMenu, parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { validateReportView } from './xuan-ib-report-view.mjs';

const fail = code => { throw new Error(`Minimal report: ${code}`); };
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const hkt = instant => new Date(Date.parse(instant) + 8 * 3_600_000).toISOString();
const sourceTime = instant => `${hkt(instant).slice(0, 10)} ${hkt(instant).slice(11, 16)} HKT`;
const amount = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const unavailableCard = (title, asOfHkt, takeaway, line) => ({
  title, asOfHkt, lines: [line], columns: [], rows: [],
  brief: { state: 'unavailable', takeaway, action: 'verify' },
});

function verifiedPreviousDecisions(previousHtml, previousMeta, previousSourceSha, dataDate) {
  // Validate the complete paired document and visible cards BEFORE extracting
  // its inert state. Never bootstrap empty history from an unparseable page.
  buildDecisionMenu({ html: previousHtml, meta: previousMeta });
  if (previousMeta.sourceSha !== previousSourceSha) fail('PREVIOUS_SOURCE_MISMATCH');
  if (dataDate < previousMeta.dataDate) fail('REPORT_DATE_REGRESSION');
  const matches = [...previousHtml.matchAll(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/g)];
  if (matches.length !== 1) fail('PREVIOUS_DECISION_STATE_REQUIRED');
  return parseDecisionJson(matches[0][1], 2_000_000).decisions;
}

function readWindow(input, now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) fail('INVALID_CLOCK');
  const receipts = [...IB_ENDPOINTS.map(name => input.ib[name]), ...input.sharesight];
  let start = Infinity, end = -Infinity;
  for (const receipt of receipts) {
    const started = Date.parse(receipt.startedAt), completed = Date.parse(receipt.completedAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > now) fail('INVALID_READ_WINDOW');
    if (hkt(receipt.startedAt).slice(0, 10) !== input.dataDate || hkt(receipt.completedAt).slice(0, 10) !== input.dataDate) fail('READ_DATE_MISMATCH');
    start = Math.min(start, started); end = Math.max(end, completed);
  }
  const startHkt = hkt(new Date(start).toISOString()), endHkt = hkt(new Date(end).toISOString());
  return `${input.dataDate} ${startHkt.slice(11, 16)}–${endHkt.slice(11, 16)} HKT`;
}

const BALANCE_KEYS = ['currency', 'cash_balance', 'settled_cash', 'net_liquidation_value',
  'stock_market_value', 'unrealized_pnl', 'realized_pnl', 'exchange_rate'];
function stockTotalFromBalances(raw) {
  const rows = unwrapSource('balances', raw).balances;
  for (const row of rows) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype
      || Object.keys(row).sort().join('|') !== [...BALANCE_KEYS].sort().join('|')) fail('UNSUPPORTED_BALANCE_SHAPE');
    if (typeof row.currency !== 'string' || (row.currency !== 'BASE' && !/^[A-Z]{3}$/.test(row.currency))) fail('INVALID_BALANCE_CURRENCY');
    if (BALANCE_KEYS.filter(key => key !== 'currency').some(key => !finite(row[key]))) fail('INVALID_BALANCE_NUMBER');
  }
  const base = rows.filter(row => row.currency === 'BASE');
  if (base.length === 0) fail('BASE_BALANCE_REQUIRED');
  if (base.length !== 1) fail('BASE_BALANCE_AMBIGUOUS');
  if (base[0].exchange_rate !== 1) fail('BASE_EXCHANGE_RATE_NOT_ONE');
  if (base[0].stock_market_value < 0) fail('AUTHORITATIVE_STOCK_VALUE_REQUIRED');
  // The caller independently requires accountSummary.currency === USD. BASE
  // is that base-currency aggregate, not another currency to sum with USD/CAD.
  // Ignore any similarly named summary field, gross exposure or NAV-cash.
  return base[0].stock_market_value;
}

function holdingsFromRaw(raw, authoritativeValueUsd, asOfHkt, aggregateAsOfHkt) {
  const native = normalizePositions(raw);
  if (native.length > 200) fail('POSITIONS_DISPLAY_LIMIT');
  if (!native.length && authoritativeValueUsd > 0) fail('POSITIVE_STOCK_VALUE_WITHOUT_POSITIONS');
  const descriptions = new Set();
  let usdSubtotal = 0, foreignRows = 0;
  const rows = native.map(position => {
    // contract_description is displayed verbatim as a native identifier. It
    // is NOT a verified ticker, exchange or mapping to another data source.
    if ([...position.description].length > 30) fail('POSITION_LABEL_TOO_LONG');
    if (descriptions.has(position.description)) fail('DUPLICATE_POSITION_LABEL');
    descriptions.add(position.description);
    const usd = position.currency === 'USD';
    if (usd) usdSubtotal += position.marketValueNative; else foreignRows++;
    return {
      symbol: position.description, market: 'IB原始标识', quantity: position.quantity,
      price: position.price, priceCurrency: position.currency,
      marketValueUsd: usd ? position.marketValueNative : null,
      changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable',
    };
  });
  if (!finite(usdSubtotal) || !finite(authoritativeValueUsd - usdSubtotal)) fail('HOLDINGS_SUBTOTAL_OUT_OF_RANGE');
  // No invented reconciliation tolerance: a difference is shown, never used
  // as a pass/fail threshold or silently forced into cash/another holding.
  const note = `股票总值：余额表 BASE（${aggregateAsOfHkt}）。已知 USD 行小计 $${amount(usdSubtotal)}；与 IB 股票市值差额 $${amount(authoritativeValueUsd - usdSubtotal)}，尚未对账。外币 ${foreignRows} 行不换汇，美元市值留空。逐行列表未作资产类别拆分，差额不代表盈亏；原始标识不是已核实代码或交易所。未查询日涨跌。`;
  return { status: 'ok', asOfHkt, authoritativeValueUsd, note, rows };
}

const ORDER_KEYS = ['order_id', 'order_status', 'order_type', 'side', 'limit_price',
  'total_shares_qty', 'cum_shares_qty', 'remaining_shares_qty', 'primary_description',
  'secondary_description', 'order_time'];
const numericOrderString = value => {
  if (typeof value !== 'string' || value.length > 160
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !finite(Number(value))) fail('INVALID_ORDER_NUMBER');
  return Number(value);
};
function orderCardFromRaw(orders, asOfHkt) {
  if (orders.length > 60) fail('ORDERS_DISPLAY_LIMIT');
  const seen = new Set();
  const entries = orders.map(order => {
    // Schema-only inspection established this exact native LIMIT-order shape.
    // The descriptions are NOT parsed for symbol, exchange or currency. No
    // quote-distance, order-age or cancellation inference is possible here.
    if (!order || Object.getPrototypeOf(order) !== Object.prototype
      || Object.keys(order).sort().join('|') !== [...ORDER_KEYS].sort().join('|')
      || !Number.isSafeInteger(order.order_id) || order.order_id < 0
      || !['NEW', 'REPLACED'].includes(order.order_status) || order.order_type !== 'LIMIT'
      || !['BUY', 'SELL'].includes(order.side)
      || typeof order.primary_description !== 'string' || !order.primary_description.trim()
      || typeof order.secondary_description !== 'string' || !order.secondary_description.trim()
      || typeof order.order_time !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(order.order_time)
      || !Number.isFinite(Date.parse(order.order_time))) fail('UNSUPPORTED_ORDER_SHAPE');
    if (seen.has(order.order_id)) fail('DUPLICATE_ORDER_ID');
    seen.add(order.order_id);
    const limit = numericOrderString(order.limit_price), total = numericOrderString(order.total_shares_qty);
    const filled = numericOrderString(order.cum_shares_qty), remaining = numericOrderString(order.remaining_shares_qty);
    if (limit <= 0 || total <= 0) fail('INVALID_ORDER_NUMBER');
    // Tolerance is limited to binary-number representation error, not an
    // economic reconciliation threshold. Display retains all original decimal
    // strings; quantities are never repaired to force the identity to hold.
    const roundingError = Number.EPSILON * Math.max(total, filled, remaining) * 4;
    if (filled > total + roundingError || remaining > total + roundingError
      || Math.abs(filled + remaining - total) > roundingError) fail('INCONSISTENT_ORDER_QUANTITIES');
    const description = `${order.primary_description}\n${order.secondary_description}`;
    const quantity = `总 ${order.total_shares_qty} / 已成交 ${order.cum_shares_qty} / 剩余 ${order.remaining_shares_qty}`;
    const limitText = `${order.limit_price}（币种未返回）`;
    if ([description, quantity, limitText].some(value => [...value].length > 160)) fail('ORDER_TEXT_TOO_LONG');
    return { side: order.side, row: [description, order.side === 'BUY' ? '买入' : '卖出', limitText, quantity, order.order_status] };
  });
  return {
    title: '换仓触发检查', asOfHkt,
    lines: [`IB 挂单端点返回 ${orders.length} 张；换仓触发条件本次未重算。`,
      '买单在前、卖单在后，同侧保留原顺序。原始说明不是已核实代码；币种、行情、距市价及待撤条件未取得或未核验。'],
    columns: orders.length ? ['原始说明', '买卖', '限价', '数量', '状态'] : ['项目', '结果'],
    rows: orders.length ? ['BUY', 'SELL'].flatMap(side => entries.filter(entry => entry.side === side).map(entry => entry.row))
      : [['IB 挂单', '0 张'], ['换仓触发', '待核验']],
    brief: { state: 'unverified', takeaway: '挂单已读取，触发条件待核验', action: 'verify' },
  };
}

/** Build the approved minimal first-trial view plus unchanged source evidence.
 * Input is the source adapter's raw 5-IB + 9-Sharesight receipt shape.
 * association options are validated by that adapter, not synthesized here.
 * The first version supports direct positions only; a failed-position source
 * must not become an empty table. Only the independently inspected native
 * LIMIT-order shape is accepted, with original descriptions and no inferred
 * instrument identifiers, currency, market-distance or cancellation flags.
 */
export function buildMinimalReport(input, {
  registry, previousHtml, previousMeta, associationReceipt = null,
  associationSnapshot = null, journalPath = null, now = Date.now(),
} = {}) {
  if (input?.edition !== 'adhoc') fail('ADHOC_TRIAL_ONLY');
  const evidence = buildSourceEvidence(input, registry, {
    associationReceipt, associationSnapshot, journalPath, now,
  });
  const previousDecisions = verifiedPreviousDecisions(previousHtml, previousMeta, input.previousSourceSha, input.dataDate);
  const asOfHkt = readWindow(input, now);
  const summary = unwrapSource('accountSummary', input.ib.accountSummary.raw);
  if (summary.currency !== 'USD') fail('USD_ACCOUNT_SUMMARY_REQUIRED');
  const equityTotal = stockTotalFromBalances(input.ib.balances.raw);
  if (evidence.sources.ib.positions.status !== 'ok') fail('DIRECT_POSITIONS_REQUIRED');
  const summaryTime = sourceTime(input.ib.accountSummary.completedAt), balancesTime = sourceTime(input.ib.balances.completedAt);
  const holdings = holdingsFromRaw(input.ib.positions.raw, equityTotal, sourceTime(input.ib.positions.completedAt), balancesTime);
  const orders = unwrapSource('orders', input.ib.orders.raw).orders;
  const rotation = orderCardFromRaw(orders, sourceTime(input.ib.orders.completedAt));
  const trades = unwrapSource('trades', input.ib.trades.raw).trades;
  const view = {
    schemaVersion: 1, edition: 'adhoc', dataDate: input.dataDate, asOfHkt,
    marketContext: '精简试跑 · 市场日历未查询，不判断休市或开盘状态',
    alerts: [{ level: 'warning', text: '精简试跑：风险、四桶与补仓金额待核验；历史意见及原有 ABC 日期保留。' }],
    summary: [
      `IB 净资产 $${amount(summary.net_liquidation)}；账面现金 $${amount(summary.total_cash_value)}。`,
      `持仓 ${holdings.rows.length} 行；挂单端点返回 ${orders.length} 张；日涨跌未查询。`,
      '风险、四桶及补仓金额本次不重算；原有 ABC 仅作历史比较。',
    ],
    kpis: [
      { label: 'IB NAV', value: summary.net_liquidation, format: 'usd', asOfHkt: summaryTime, note: 'IB 账户摘要直读，不代表当日收益。' },
      { label: 'IB 账面现金', value: summary.total_cash_value, format: 'usd', asOfHkt: summaryTime, note: '不是可投资余额；未扣 CALL 预留，也未加入 NOAH 现金。' },
      { label: 'IB 股票市值', value: equityTotal, format: 'usd', asOfHkt: balancesTime, note: 'IB 余额表 BASE 汇总直读；BASE 对应 USD，不累加币种分项。' },
    ],
    holdings,
    risk: [unavailableCard('② 风险', asOfHkt, '风险指标本次未重算', 'AI 压力、集中度及触发指标待核验；不将历史数值当本期结果。')],
    allocation: [unavailableCard('④ 配置', asOfHkt, '四桶及补仓金额待核验', '本次未重算四桶、类别缺口及现金分配；不生成股数、限价或交易指令。')],
    rotation,
    events: unavailableCard('事件日历', asOfHkt, '事件日历未查询', '未查询不代表没有事件；本次不作事件风险判断。'),
    decisions: previousDecisions.map(item => ({
      decisionId: item.decisionId, asOfHkt,
      fact: '本次未重算该事项；原意见与回执保留，不据此宣称已经落实。', isNew: false,
    })),
    observations: [`成交端点返回 ${trades.length} 条；本次未判定其中的新成交。`],
    notes: [
      `版次与时点：手动精简试跑，${asOfHkt}。显示读取时间，不把历史估值日改成本日。`,
      '数据与口径：5 个 IB 端点及 9 个必读 Sharesight 组合均经原始回执校验。Sharesight 数值未用于本次现金、风险或配置汇总。风险、四桶及补仓未重算；原有 ABC 保留原始日期，不是本次刷新。',
      '只读边界：不下单、撤单、改单或转账。历史意见与回执完整继承；生成候选页不等于发布成功，也不证明十分钟目标达成。',
    ],
    cashPlan: { schemaVersion: 2, status: 'unavailable' },
  };
  validateReportView(view);
  return { view, evidence };
}
