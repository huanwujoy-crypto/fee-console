const fail = code => { throw new Error(`Night action view: ${code}`); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
const text = value => typeof value === 'string' && value.trim() && [...value].length <= 160;
const esc = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
const percent = value => `${value.toFixed(1)}%`;
export const NIGHT_ACTION_MARKER = 'xuan-ib-night-action-v1';

function validateOrder(order, schemaVersion) {
  if (!object(order) || !['BUY', 'SELL'].includes(order.side)
    || !text(order.description) || !text(order.limit) || !text(order.quantity)
    || !text(order.status)) fail('INVALID_ORDER');
  if (schemaVersion >= 2) {
    if (!(order.currency === null || /^[A-Z]{3}$/.test(order.currency))
      || !(order.ageDays === null || Number.isInteger(order.ageDays) && order.ageDays >= 0)
      || !(order.distancePct === null || typeof order.distancePct === 'number' && Number.isFinite(order.distancePct))) fail('INVALID_ORDER_DETAIL');
    if (order.trend !== null) {
      const trend = order.trend;
      if (!object(trend) || !/^[0-9a-f]{64}$/.test(trend.key)
        || !/^\d{4}-\d{2}-\d{2}$/.test(trend.firstDate) || !finite(trend.firstPrice)
        || !Number.isInteger(trend.ageDays) || trend.ageDays < 0
        || !['none', 'up', 'down', 'flat'].includes(trend.kind)
        || !(trend.label === null || text(trend.label)) || (trend.kind === 'none') !== (trend.label === null)) fail('INVALID_ORDER_TREND');
    }
  }
}

export function validateNightActionModel(model) {
  if (!object(model) || ![1, 2, 3].includes(model.schemaVersion)
    || !/^\d{4}-\d{2}-\d{2}$/.test(model.dataDate)
    || !text(model.asOfHkt) || !['ready', 'partial'].includes(model.status)) fail('INVALID_HEADER');
  const plan = model.replenishment;
  if (!object(plan) || !['ready', 'unavailable'].includes(plan.status)) fail('INVALID_REPLENISHMENT');
  if (plan.status === 'ready') {
    if (!finite(plan.total) || !Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 6) fail('INVALID_REPLENISHMENT');
    if (plan.items.some(item => !object(item) || !/^[A-Z][A-Z0-9.]{0,11}$/.test(item.symbol)
      || !finite(item.amount)) || Math.abs(plan.items.reduce((sum, item) => sum + item.amount, 0) - plan.total) > 0.011) {
      fail('INVALID_REPLENISHMENT');
    }
    if (model.schemaVersion >= 3 && (!finite(plan.budget) || !finite(plan.retained)
      || Math.abs(plan.total + plan.retained - plan.budget) > 0.011)) fail('INVALID_REPLENISHMENT');
  }
  if (!object(model.orders) || !['ready', 'unavailable'].includes(model.orders.status)
    || !text(model.orders.asOfHkt) || !Array.isArray(model.orders.buys) || !Array.isArray(model.orders.sells)
    || model.orders.buys.length + model.orders.sells.length > 60
    || (model.orders.status === 'unavailable' && (model.orders.buys.length || model.orders.sells.length))) fail('INVALID_ORDERS');
  [...model.orders.buys, ...model.orders.sells].forEach(order => validateOrder(order, model.schemaVersion));
  if (model.orders.buys.some(order => order.side !== 'BUY')
    || model.orders.sells.some(order => order.side !== 'SELL')) fail('ORDER_GROUP_MISMATCH');
  const cash = model.cash;
  if (!object(cash) || !['ready', 'unavailable'].includes(cash.status)) fail('INVALID_CASH');
  if (cash.status === 'ready' && (![cash.pool, cash.reserve, cash.planning].every(finite)
      || Math.abs(Math.max(0, cash.pool - cash.reserve) - cash.planning) > 0.011)) fail('INVALID_CASH');
  if (cash.status === 'ready' && model.schemaVersion >= 3) {
    if (![cash.ib, cash.noah, cash.totalCapacity].every(finite)
      || Math.abs(cash.ib + cash.noah - cash.pool) > 0.011
      || !object(cash.cashLike) || !finite(cash.cashLike.total)
      || !Array.isArray(cash.cashLike.items) || cash.cashLike.items.length > 3
      || cash.cashLike.items.some(item => !object(item) || !['VGSH', 'VGIT', 'TLT'].includes(item.symbol)
        || !finite(item.amount))
      || Math.abs(cash.cashLike.items.reduce((sum, item) => sum + item.amount, 0) - cash.cashLike.total) > 0.011
      || Math.abs(cash.planning + cash.cashLike.total - cash.totalCapacity) > 0.011) fail('INVALID_CASH');
  }
  if (!object(model.allocation) || !['ready', 'unavailable'].includes(model.allocation.status)) fail('INVALID_ALLOCATION');
  if (model.allocation.status === 'ready') {
    if (!finite(model.allocation.total) || model.allocation.total <= 0
      || !Array.isArray(model.allocation.categories) || model.allocation.categories.length !== 4) fail('INVALID_ALLOCATION');
    for (const item of model.allocation.categories) {
      if (!object(item) || !text(item.label) || !finite(item.marketValue)
        || !finite(item.currentPct) || item.currentPct > 100
        || !finite(item.targetPct) || item.targetPct > 100) fail('INVALID_ALLOCATION');
    }
  }
  if (!Array.isArray(model.notes) || model.notes.length > 3 || model.notes.some(note => !text(note))) fail('INVALID_NOTES');
  return model;
}

export function extractNightActionModel(html) {
  if (typeof html !== 'string') fail('INVALID_HTML');
  const matches = [...html.matchAll(new RegExp(`<!--\\s*${NIGHT_ACTION_MARKER}:([A-Za-z0-9_-]+)\\s*-->`, 'g'))];
  if (matches.length !== 1 || html.split(NIGHT_ACTION_MARKER).length !== 2) fail('INVALID_MARKER');
  let model;
  try { model = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8')); }
  catch { fail('INVALID_MARKER'); }
  validateNightActionModel(model);
  if (Buffer.from(JSON.stringify(model), 'utf8').toString('base64url') !== matches[0][1]) fail('NONCANONICAL_MARKER');
  return model;
}

const signedPercent = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
function renderOrders(title, rows, kind, schemaVersion) {
  const cards = rows.length ? rows.map((order, index) => {
    if (schemaVersion === 1) return `<article class="order ${kind}">
<div><b>${esc(order.description)}</b><span>${esc(order.status)}</span></div>
<dl><div><dt>限价</dt><dd>${esc(order.limit)}</dd></div><div><dt>数量</dt><dd>${esc(order.quantity)}</dd></div></dl>
</article>`;
    const trendAttrs = order.trend ? ` data-order-trend-v1="1" data-order-key="${order.trend.key}" data-order-first-date="${order.trend.firstDate}" data-order-first-price="${order.trend.firstPrice}" data-order-age-days="${order.trend.ageDays}"` : '';
    const trend = order.trend?.label ? `<em class="trend ${order.trend.kind}">${esc(order.trend.label)}</em>` : '';
    return `<article class="order ${kind} detailed"${trendAttrs}>
<div class="order-main"><div><b>${index + 1}. ${esc(order.description)} ×${esc(order.quantity)}</b><span>${order.ageDays === null ? '' : `${order.ageDays}天 · `}${esc(order.status)}</span>${trend}</div><div class="quote"><b>${esc(order.limit)}</b><span>${order.currency ? esc(order.currency) : ''}</span></div><b class="distance">${signedPercent(order.distancePct)}</b></div>
</article>`;
  }).join('') : '<p class="empty">无</p>';
  return `<section class="order-group"><h3>${title}<small>${rows.length} 张</small></h3>${cards}</section>`;
}

export function renderNightActionReport(model) {
  validateNightActionModel(model);
  const marker = Buffer.from(JSON.stringify(model), 'utf8').toString('base64url');
  const plan = model.replenishment.status === 'ready'
    ? `<div class="hero-value">${money(model.replenishment.total)}</div><div class="chips">${model.replenishment.items.map(item => `<span><b>${esc(item.symbol)}</b>${money(item.amount)}</span>`).join('')}</div>${model.schemaVersion >= 3 ? `<p class="plan-balance">现金预算 ${money(model.replenishment.budget)}${model.replenishment.retained > 0.01 ? ` · 暂留 ${money(model.replenishment.retained)}` : ' · 已全部规划'}</p>` : ''}`
    : '<div class="unavailable">本轮未取得，不沿用旧金额</div>';
  const cash = model.cash.status === 'ready' && model.schemaVersion >= 3 ? `<div class="metrics three">
<div><span>现金池</span><b>${money(model.cash.pool)}</b></div>
<div><span>预留待 CALL</span><b>${money(model.cash.reserve)}</b></div>
<div><span>可补仓现金</span><b>${money(model.cash.planning)}</b></div>
</div><div class="cash-detail"><p><b>组成</b><span>IB ${money(model.cash.ib)} · NOAH-HK ${money(model.cash.noah)}</span></p><p><b>类现金</b><span>${model.cash.cashLike.total > 0 ? `${money(model.cash.cashLike.total)} · ${model.cash.cashLike.items.map(item => `${item.symbol} ${money(item.amount)}`).join(' · ')}` : '$0'}</span></p><p class="capacity"><b>全部弹药</b><span>${money(model.cash.totalCapacity)}</span></p><small>全部弹药＝可补仓现金＋类现金；类现金不默认卖出。</small></div>`
    : model.cash.status === 'ready' ? `<div class="metrics three">
<div><span>现金池</span><b>${money(model.cash.pool)}</b></div>
<div><span>预留待 CALL</span><b>${money(model.cash.reserve)}</b></div>
<div><span>可规划</span><b>${money(model.cash.planning)}</b></div>
</div>` : '<div class="unavailable">现金口径未齐，本轮不计算</div>';
  const allocation = model.allocation.status === 'ready' ? `<div class="allocation">
${model.allocation.categories.map(item => `<div><span>${esc(item.label)}</span><b>${percent(item.currentPct)} <i>→</i> ${percent(item.targetPct)}</b><small>${money(item.marketValue)}</small></div>`).join('')}
</div>` : '<div class="unavailable">四类数据未齐，本轮不显示旧值</div>';
  const orders = model.orders.status === 'ready'
    ? `<div class="orders">${renderOrders('买单', model.orders.buys, 'buy', model.schemaVersion)}${renderOrders('卖单', model.orders.sells, 'sell', model.schemaVersion)}</div>`
    : '<div class="unavailable">实时挂单尚未接入，本轮显示“未取得”</div>';
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN · 睡前行动版</title><style>
:root{color-scheme:light;--bg:#f6f7f8;--card:#fff;--text:#17191c;--mut:#6c727a;--line:#e4e6e8;--buy:#18794e;--sell:#b42318;--blue:#1769aa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:auto;padding:calc(16px + env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom))}header{padding:4px 2px 10px}h1{font-size:24px;margin:0}header p{margin:4px 0 0;color:var(--mut);font-size:13px}.state{float:right;color:${model.status === 'ready' ? 'var(--buy)' : '#9a6700'};font-weight:700}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 1px 2px #00000008}.card h2{font-size:19px;margin:0 0 12px}.card h2 small{font-size:12px;color:var(--mut);font-weight:500;margin-left:7px}.hero-value{font-size:34px;font-weight:800;letter-spacing:-1px}.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.chips span{display:flex;gap:8px;padding:8px 10px;border-radius:10px;background:#edf6ff;color:#164f79}.plan-balance{color:var(--mut);font-size:12px;margin:9px 0 0}.orders{display:grid;grid-template-columns:1fr 1fr;gap:12px}.order-group h3{display:flex;justify-content:space-between;margin:0 0 8px;font-size:16px}.order-group h3 small{font-weight:500;color:var(--mut)}.order{border:1px solid var(--line);border-left:4px solid;border-radius:12px;padding:11px;margin:8px 0}.order.buy{border-left-color:var(--buy)}.order.sell{border-left-color:var(--sell)}.order>div{display:flex;justify-content:space-between;gap:8px}.order>div span{color:var(--mut);font-size:12px}.order dl{display:grid;grid-template-columns:1fr 1fr;margin:9px 0 0;gap:8px}.order dl div{min-width:0}.order dt{font-size:12px;color:var(--mut)}.order dd{margin:2px 0 0;font-weight:650;overflow-wrap:anywhere}.order.detailed{border-left-width:1px}.order .order-main{display:grid;grid-template-columns:minmax(0,1fr) 58px 64px;align-items:start;gap:8px}.order-main>div:first-child{min-width:0}.order-main>div:first-child span,.order-main .trend{display:block}.order-main .trend{font-style:normal;color:var(--mut);font-size:12px;margin-top:2px}.order-main .trend.up{color:var(--buy)}.order-main .trend.down{color:var(--sell)}.quote{text-align:center}.quote b,.quote span{display:block}.distance{text-align:right}.empty,.unavailable{color:var(--mut);margin:4px 0}.metrics{display:grid;gap:8px}.metrics.three{grid-template-columns:repeat(3,1fr)}.metrics div,.allocation>div{background:#f7f8f9;border-radius:12px;padding:11px;min-width:0}.metrics span,.allocation span,.allocation small{display:block;color:var(--mut);font-size:12px}.metrics b{display:block;font-size:18px;margin-top:3px;overflow-wrap:anywhere}.cash-detail{margin-top:10px;border-top:1px solid var(--line);padding-top:7px}.cash-detail p{display:flex;justify-content:space-between;gap:12px;margin:7px 0}.cash-detail p b{white-space:nowrap}.cash-detail p span{text-align:right}.cash-detail .capacity{font-size:18px}.cash-detail small{display:block;color:var(--mut);font-size:11px}.allocation{display:grid;grid-template-columns:1fr 1fr;gap:8px}.allocation>div{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 8px}.allocation b{white-space:nowrap}.allocation i{font-style:normal;color:var(--mut)}.allocation small{grid-column:1/-1}.notes{font-size:12px;color:var(--mut);padding:2px 4px}.notes p{margin:4px 0}@media(max-width:520px){.orders{grid-template-columns:1fr}.metrics.three{grid-template-columns:1fr 1fr}.metrics.three div:last-child{grid-column:1/-1}.allocation{grid-template-columns:1fr}h1{font-size:22px}.card{padding:14px}.hero-value{font-size:31px}.cash-detail p{font-size:13px}}
</style></head><body><!-- ${NIGHT_ACTION_MARKER}:${marker} --><main>
<header><span class="state">${model.status === 'ready' ? '已更新' : '部分更新'}</span><h1>XUAN · 睡前行动版</h1><p>${esc(model.dataDate)} · ${esc(model.asOfHkt)}</p></header>
<section class="card"><h2>今晚补仓<small>规划 · 非下单</small></h2>${plan}</section>
<section class="card"><h2>挂单提醒<small>${esc(model.orders.asOfHkt)}</small></h2>${orders}</section>
<section class="card"><h2>现金优先补仓参考</h2>${cash}</section>
<section class="card"><h2>股票四类配置<small>当前 → 参考目标</small></h2>${allocation}</section>
<footer class="notes">${model.notes.map(note => `<p>${esc(note)}</p>`).join('')}</footer>
</main></body></html>`;
}
