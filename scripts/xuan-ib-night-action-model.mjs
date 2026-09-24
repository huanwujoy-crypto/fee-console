import { calculateCashPlan } from './xuan-ib-cash-plan.mjs';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';
import { parseSharesightCash, parseSharesightStockAllocation } from './xuan-ib-sharesight-allocation.mjs';
import { validateNightActionModel } from './xuan-ib-night-action-view.mjs';

const fail = code => { throw new Error(`Night action model: ${code}`); };
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
const ORDER_KEYS = ['order_id', 'order_status', 'order_type', 'side', 'limit_price',
  'total_shares_qty', 'cum_shares_qty', 'remaining_shares_qty', 'primary_description',
  'secondary_description', 'order_time'];
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function orderNumber(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    || !Number.isFinite(Number(value))) fail('INVALID_ORDER_NUMBER');
  return Number(value);
}

function ordersOf(raw) {
  const orders = unwrapSource('orders', raw).orders;
  const seen = new Set();
  const normalized = orders.map(order => {
    if (!exactKeys(order, ORDER_KEYS) || !Number.isSafeInteger(order.order_id) || order.order_id < 0
      || seen.has(order.order_id) || !['NEW', 'REPLACED'].includes(order.order_status)
      || order.order_type !== 'LIMIT' || !['BUY', 'SELL'].includes(order.side)
      || typeof order.primary_description !== 'string' || !order.primary_description.trim()
      || typeof order.secondary_description !== 'string' || !order.secondary_description.trim()) fail('INVALID_ORDER');
    seen.add(order.order_id);
    const total = orderNumber(order.total_shares_qty), filled = orderNumber(order.cum_shares_qty);
    const remaining = orderNumber(order.remaining_shares_qty), limit = orderNumber(order.limit_price);
    const tolerance = Number.EPSILON * Math.max(total, filled, remaining) * 4;
    if (limit <= 0 || total <= 0 || Math.abs(filled + remaining - total) > tolerance) fail('INVALID_ORDER_NUMBER');
    return {
      side: order.side,
      description: order.primary_description.trim(),
      limit: `${order.limit_price} · 币种未返回`,
      quantity: order.remaining_shares_qty,
      status: order.order_status,
    };
  });
  return {
    buys: normalized.filter(order => order.side === 'BUY'),
    sells: normalized.filter(order => order.side === 'SELL'),
  };
}

/** Build the entire action-only page from four read-only responses:
 * IB account summary, IB orders, grouped IB-HK Sharesight performance, and
 * NOAH-HK Sharesight performance. No positions/trades/all-family reads.
 */
export function buildNightActionModel({
  dataDate, asOfHkt, ordersAsOfHkt, ibAccountSummary, ibOrders,
  ibGroupedPerformance, noahPerformance, reserve,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate || '') || typeof asOfHkt !== 'string'
    || typeof ordersAsOfHkt !== 'string' || !finite(reserve)) fail('INVALID_INPUT');
  const summary = unwrapSource('accountSummary', ibAccountSummary);
  if (summary.currency !== 'USD' || !finite(summary.total_cash_value)) fail('USD_ACCOUNT_SUMMARY_REQUIRED');
  const allocation = parseSharesightStockAllocation(ibGroupedPerformance);
  const noahCash = parseSharesightCash(noahPerformance, { portfolioId: 936238 });
  const orderGroups = ordersOf(ibOrders);
  // Broker and Sharesight sources may retain sub-cent FX precision. This
  // planning view intentionally works at USD-cent precision.
  const ibCash = Math.round(summary.total_cash_value * 100) / 100;
  const noahCashTotal = Math.round(noahCash.total * 100) / 100;
  const cashPool = Math.round((ibCash + noahCashTotal) * 100) / 100;
  const planning = Math.max(0, Math.round((cashPool - reserve) * 100) / 100);
  let replenishment = { status: 'unavailable' };
  try {
    const plan = calculateCashPlan({
      schemaVersion: 2, status: 'snapshot', sourceAsOfHkt: asOfHkt,
      equityTotal: allocation.total, developed: allocation.developed, emerging: allocation.emerging,
      usBase: allocation.usBase, ussc: allocation.ussc, ibCash,
      noahCash: noahCashTotal, reserve, usscBudgetShare: 0.10,
      currency: 'USD', denominator: 'equity-only',
    });
    const [exus, eimi, ussc] = plan.allocations;
    replenishment = { status: 'ready', total: plan.plannedSpend, items: [
      { symbol: 'EXUS', amount: exus }, { symbol: 'EIMI', amount: eimi }, { symbol: 'USSC', amount: ussc },
    ] };
  } catch {
    // A policy edge case (for example surplus cash after all approved gaps are
    // filled) must not block live orders or copy a previous recommendation.
    replenishment = { status: 'unavailable' };
  }
  const model = {
    schemaVersion: 1, dataDate, asOfHkt,
    status: replenishment.status === 'ready' ? 'ready' : 'partial',
    replenishment,
    orders: { status: 'ready', asOfHkt: ordersAsOfHkt, ...orderGroups },
    cash: { status: 'ready', pool: cashPool, reserve, planning },
    allocation: { status: 'ready', total: allocation.total, categories: allocation.categories },
    notes: [
      `四类：Sharesight 资产类别，数据日 ${allocation.dataDate}。`,
      `NOAH-HK 现金数据日 ${noahCash.dataDate}；IB 挂单为本轮直读。`,
      '只读规划：不下单、撤单、改单或转账。',
    ],
  };
  return validateNightActionModel(model);
}
