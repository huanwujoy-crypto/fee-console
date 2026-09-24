const fail = code => { throw new Error(`Night action view: ${code}`); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
const text = value => typeof value === 'string' && value.trim() && [...value].length <= 160;
const esc = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
const percent = value => `${value.toFixed(1)}%`;

function validateOrder(order) {
  if (!object(order) || !['BUY', 'SELL'].includes(order.side)
    || !text(order.description) || !text(order.limit) || !text(order.quantity)
    || !text(order.status)) fail('INVALID_ORDER');
}

export function validateNightActionModel(model) {
  if (!object(model) || model.schemaVersion !== 1
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
  }
  if (!object(model.orders) || !text(model.orders.asOfHkt)
    || !Array.isArray(model.orders.buys) || !Array.isArray(model.orders.sells)
    || model.orders.buys.length + model.orders.sells.length > 60) fail('INVALID_ORDERS');
  [...model.orders.buys, ...model.orders.sells].forEach(validateOrder);
  if (model.orders.buys.some(order => order.side !== 'BUY')
    || model.orders.sells.some(order => order.side !== 'SELL')) fail('ORDER_GROUP_MISMATCH');
  const cash = model.cash;
  if (!object(cash) || !['ready', 'unavailable'].includes(cash.status)) fail('INVALID_CASH');
  if (cash.status === 'ready' && (![cash.pool, cash.reserve, cash.planning].every(finite)
      || Math.abs(Math.max(0, cash.pool - cash.reserve) - cash.planning) > 0.011)) fail('INVALID_CASH');
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

function renderOrders(title, rows, kind) {
  const cards = rows.length ? rows.map(order => `<article class="order ${kind}">
<div><b>${esc(order.description)}</b><span>${esc(order.status)}</span></div>
<dl><div><dt>限价</dt><dd>${esc(order.limit)}</dd></div><div><dt>数量</dt><dd>${esc(order.quantity)}</dd></div></dl>
</article>`).join('') : '<p class="empty">无</p>';
  return `<section class="order-group"><h3>${title}<small>${rows.length} 张</small></h3>${cards}</section>`;
}

export function renderNightActionReport(model) {
  validateNightActionModel(model);
  const plan = model.replenishment.status === 'ready'
    ? `<div class="hero-value">${money(model.replenishment.total)}</div><div class="chips">${model.replenishment.items.map(item => `<span><b>${esc(item.symbol)}</b>${money(item.amount)}</span>`).join('')}</div>`
    : '<div class="unavailable">本轮未取得，不沿用旧金额</div>';
  const cash = model.cash.status === 'ready' ? `<div class="metrics three">
<div><span>现金池</span><b>${money(model.cash.pool)}</b></div>
<div><span>预留待 CALL</span><b>${money(model.cash.reserve)}</b></div>
<div><span>可规划</span><b>${money(model.cash.planning)}</b></div>
</div>` : '<div class="unavailable">现金口径未齐，本轮不计算</div>';
  const allocation = model.allocation.status === 'ready' ? `<div class="allocation">
${model.allocation.categories.map(item => `<div><span>${esc(item.label)}</span><b>${percent(item.currentPct)} <i>→</i> ${percent(item.targetPct)}</b><small>${money(item.marketValue)}</small></div>`).join('')}
</div>` : '<div class="unavailable">四类数据未齐，本轮不显示旧值</div>';
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>XUAN · 睡前行动版</title><style>
:root{color-scheme:light;--bg:#f6f7f8;--card:#fff;--text:#17191c;--mut:#6c727a;--line:#e4e6e8;--buy:#18794e;--sell:#b42318;--blue:#1769aa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:auto;padding:calc(16px + env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom))}header{padding:4px 2px 10px}h1{font-size:24px;margin:0}header p{margin:4px 0 0;color:var(--mut);font-size:13px}.state{float:right;color:${model.status === 'ready' ? 'var(--buy)' : '#9a6700'};font-weight:700}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 1px 2px #00000008}.card h2{font-size:19px;margin:0 0 12px}.card h2 small{font-size:12px;color:var(--mut);font-weight:500;margin-left:7px}.hero-value{font-size:34px;font-weight:800;letter-spacing:-1px}.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.chips span{display:flex;gap:8px;padding:8px 10px;border-radius:10px;background:#edf6ff;color:#164f79}.orders{display:grid;grid-template-columns:1fr 1fr;gap:12px}.order-group h3{display:flex;justify-content:space-between;margin:0 0 8px;font-size:16px}.order-group h3 small{font-weight:500;color:var(--mut)}.order{border:1px solid var(--line);border-left:4px solid;border-radius:12px;padding:11px;margin:8px 0}.order.buy{border-left-color:var(--buy)}.order.sell{border-left-color:var(--sell)}.order>div{display:flex;justify-content:space-between;gap:8px}.order>div span{color:var(--mut);font-size:12px}.order dl{display:grid;grid-template-columns:1fr 1fr;margin:9px 0 0;gap:8px}.order dl div{min-width:0}.order dt{font-size:12px;color:var(--mut)}.order dd{margin:2px 0 0;font-weight:650;overflow-wrap:anywhere}.empty,.unavailable{color:var(--mut);margin:4px 0}.metrics{display:grid;gap:8px}.metrics.three{grid-template-columns:repeat(3,1fr)}.metrics div,.allocation>div{background:#f7f8f9;border-radius:12px;padding:11px;min-width:0}.metrics span,.allocation span,.allocation small{display:block;color:var(--mut);font-size:12px}.metrics b{display:block;font-size:18px;margin-top:3px;overflow-wrap:anywhere}.allocation{display:grid;grid-template-columns:1fr 1fr;gap:8px}.allocation>div{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 8px}.allocation b{white-space:nowrap}.allocation i{font-style:normal;color:var(--mut)}.allocation small{grid-column:1/-1}.notes{font-size:12px;color:var(--mut);padding:2px 4px}.notes p{margin:4px 0}@media(max-width:520px){.orders{grid-template-columns:1fr}.metrics.three{grid-template-columns:1fr 1fr}.metrics.three div:last-child{grid-column:1/-1}.allocation{grid-template-columns:1fr}h1{font-size:22px}.card{padding:14px}.hero-value{font-size:31px}}
</style></head><body><main>
<header><span class="state">${model.status === 'ready' ? '已更新' : '部分更新'}</span><h1>XUAN · 睡前行动版</h1><p>${esc(model.dataDate)} · ${esc(model.asOfHkt)}</p></header>
<section class="card"><h2>今晚补仓<small>规划 · 非下单</small></h2>${plan}</section>
<section class="card"><h2>挂单提醒<small>${esc(model.orders.asOfHkt)}</small></h2><div class="orders">${renderOrders('买单', model.orders.buys, 'buy')}${renderOrders('卖单', model.orders.sells, 'sell')}</div></section>
<section class="card"><h2>现金优先补仓参考</h2>${cash}</section>
<section class="card"><h2>股票四类配置<small>当前 → 参考目标</small></h2>${allocation}</section>
<footer class="notes">${model.notes.map(note => `<p>${esc(note)}</p>`).join('')}</footer>
</main></body></html>`;
}
