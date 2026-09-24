import { calculateCashPlan } from './xuan-ib-cash-plan.mjs';
import { normalizePositions, unwrapSource } from './xuan-ib-source-adapter.mjs';
import { orderTrendKey } from './xuan-ib-order-view.mjs';
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

const attr = (tag, name) => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;
function previousTrends(previousHtml) {
  const result = new Map();
  if (typeof previousHtml !== 'string') return result;
  for (const match of previousHtml.matchAll(/<(?:tr|article)\b[^<>]*\bdata-order-trend-v1="1"[^<>]*>/g)) {
    const tag = match[0], key = attr(tag, 'data-order-key'), firstDate = attr(tag, 'data-order-first-date');
    const firstPrice = attr(tag, 'data-order-first-price'), ageDays = attr(tag, 'data-order-age-days');
    if (!/^[0-9a-f]{64}$/.test(key || '') || !/^\d{4}-\d{2}-\d{2}$/.test(firstDate || '')
      || !/^\d+(?:\.\d+)?$/.test(firstPrice || '') || !/^\d+$/.test(ageDays || '') || result.has(key)) continue;
    const price = Number(firstPrice);
    if (Number.isFinite(price) && price > 0) result.set(key, { firstDate, firstPrice: price, ageDays: Number(ageDays) });
  }
  return result;
}

function hktDate(instant) {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + 8 * 3_600_000).toISOString().slice(0, 10);
}

function orderSymbol(order, total) {
  const side = order.side === 'BUY' ? 'Buy' : 'Sell';
  const match = order.primary_description.trim().match(/^(Buy|Sell)\s+(\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9./ -]{0,20})$/);
  if (match && match[1] === side && Number(match[2]) === total) return match[3].trim().toUpperCase();
  return /^[A-Z][A-Z0-9./ -]{0,20}$/.test(order.primary_description.trim())
    ? order.primary_description.trim().toUpperCase() : null;
}

function ordersOf(raw, positionsRaw, { dataDate, previousHtml }) {
  const orders = unwrapSource('orders', raw).orders;
  const positions = new Map();
  for (const position of normalizePositions(positionsRaw)) {
    const key = position.description.trim().toUpperCase();
    if (positions.has(key)) positions.set(key, null); else positions.set(key, position);
  }
  const previous = previousTrends(previousHtml);
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
    const symbol = orderSymbol(order, total), position = symbol ? positions.get(symbol) : null;
    const currency = position?.currency ?? null;
    const marketPrice = position?.price > 0 ? position.price : null;
    const placedDate = hktDate(order.order_time);
    const ageDays = placedDate && placedDate <= dataDate
      ? Math.round((Date.parse(`${dataDate}T00:00:00Z`) - Date.parse(`${placedDate}T00:00:00Z`)) / 86400000) : null;
    let trend = null;
    if (symbol && currency && marketPrice && ageDays !== null) {
      const normalizedOrder = { symbol, side: order.side.toLowerCase(), quantity: remaining,
        limitPrice: limit, currency };
      const key = orderTrendKey(normalizedOrder), old = previous.get(key);
      const base = old && old.firstDate <= dataDate && old.ageDays <= ageDays
        ? old : { firstDate: dataDate, firstPrice: marketPrice, ageDays };
      const observedDays = Math.max(0, Math.round((Date.parse(`${dataDate}T00:00:00Z`)
        - Date.parse(`${base.firstDate}T00:00:00Z`)) / 86400000));
      const pct = observedDays ? (marketPrice / base.firstPrice - 1) * 100 : null;
      trend = { key, firstDate: base.firstDate, firstPrice: base.firstPrice, ageDays,
        kind: pct === null ? 'none' : pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat',
        label: pct === null ? null : `约 ${Math.abs(pct) < 0.05 ? '→' : pct > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}% · 观察${observedDays}天` };
    }
    return {
      side: order.side,
      description: symbol ?? order.primary_description.trim(),
      limit: order.limit_price,
      quantity: order.remaining_shares_qty,
      status: order.order_status, currency, ageDays,
      distancePct: marketPrice === null ? null : Math.round((limit / marketPrice - 1) * 1_000_000) / 10_000,
      trend,
    };
  });
  const byDistance = (a, b) => (a.distancePct === null ? Infinity : Math.abs(a.distancePct))
    - (b.distancePct === null ? Infinity : Math.abs(b.distancePct));
  return {
    buys: normalized.filter(order => order.side === 'BUY').sort(byDistance),
    sells: normalized.filter(order => order.side === 'SELL').sort(byDistance),
  };
}

/** Build the entire action-only page from five read-only responses:
 * IB account summary, positions and orders, grouped IB-HK Sharesight performance, and
 * NOAH-HK Sharesight performance. No positions/trades/all-family reads.
 */
export function buildNightActionModel({
  dataDate, asOfHkt, ordersAsOfHkt, ibAccountSummary, ibOrders,
  ibPositions, ibGroupedPerformance, noahPerformance, reserve, previousHtml = '',
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate || '') || typeof asOfHkt !== 'string'
    || typeof ordersAsOfHkt !== 'string' || !finite(reserve)) fail('INVALID_INPUT');
  const summary = unwrapSource('accountSummary', ibAccountSummary);
  if (summary.currency !== 'USD' || !finite(summary.total_cash_value)) fail('USD_ACCOUNT_SUMMARY_REQUIRED');
  const allocation = parseSharesightStockAllocation(ibGroupedPerformance);
  const noahCash = parseSharesightCash(noahPerformance, { portfolioId: 936238 });
  const orderGroups = ordersOf(ibOrders, ibPositions, { dataDate, previousHtml });
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
    schemaVersion: 2, dataDate, asOfHkt,
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
