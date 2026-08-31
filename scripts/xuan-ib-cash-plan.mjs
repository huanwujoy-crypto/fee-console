import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CASH_PLAN_ID = 'xuan-ib-cash-plan-v1';
const TARGETS = [0.23, 0.12];
const INPUT_KEYS = ['schemaVersion', 'status', 'sourceAsOfHkt', 'equityTotal', 'developed', 'emerging', 'ibCash', 'noahCash', 'reserve', 'currency', 'denominator'];
const money = value => '$' + Math.round(value).toLocaleString('en-US');
const percent = value => (value * 100).toFixed(2) + '%';
const cents = value => Math.round(value * 100) / 100;

function validSourceTime(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?:–(\d{2}):(\d{2}))? HKT$/);
  if (!match) return false;
  const [, y, m, d, h, min, endH = h, endMin = min] = match.map((v, i) => i === 0 || v === undefined ? v : Number(v));
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    && h < 24 && endH < 24 && min < 60 && endMin < 60 && endH * 60 + endMin >= h * 60 + min;
}

// Planning only. No quotes, orders, sales proceeds, transfer assumptions or
// financial connectors. Targets and account scope are unchanged.
export function calculateCashPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !INPUT_KEYS.includes(key)) || input.schemaVersion !== 1) throw new Error('Invalid cash-plan schema');
  if (input.status === 'unavailable') {
    if (Object.keys(input).some(key => !['schemaVersion', 'status'].includes(key))) throw new Error('Unavailable cash plan must not contain guessed inputs');
    return { status: 'unavailable' };
  }
  if (input.status !== 'snapshot' || !validSourceTime(input.sourceAsOfHkt)) throw new Error('Valid cash-plan source date and ordered time range are required');
  if (input.currency !== 'USD' || input.denominator !== 'equity-only') throw new Error('Cash plan requires all values in USD and an equity-only denominator');
  for (const key of INPUT_KEYS.slice(3, 9)) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1e12) throw new Error(`Invalid cash-plan input: ${key}`);
  }
  const { equityTotal: total, developed, emerging, ibCash, noahCash, reserve } = input;
  if (total <= 0 || developed + emerging > total + Math.min(1, total * 1e-6)) throw new Error('Cash-plan holdings do not reconcile to the equity denominator');
  const holdings = [developed, emerging];
  // Solve S=sum(max(0, target_i*(T+S)-holding_i)). Active-set enumeration
  // handles a category already at/above target without inventing a sale.
  let full = null;
  for (let mask = 0; mask < 4; mask++) {
    const active = [0, 1].filter(i => mask & (1 << i));
    const amount = active.reduce((sum, i) => sum + TARGETS[i] * total - holdings[i], 0)
      / (1 - active.reduce((sum, i) => sum + TARGETS[i], 0));
    if (amount < -1e-7) continue;
    const allocations = holdings.map((holding, i) => Math.max(0, TARGETS[i] * (total + Math.max(0, amount)) - holding));
    if (Math.abs(allocations[0] + allocations[1] - amount) <= Math.max(1e-5, total * 1e-12)) { full = allocations; break; }
  }
  if (!full) throw new Error('Cash-plan target system has no valid buy-only solution');
  const fullNeed = full[0] + full[1];
  for (const value of [ibCash, noahCash, reserve]) {
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-4) throw new Error('Cash inputs must be specified to cents');
  }
  const budget = Math.max(0, (Math.round(ibCash * 100) + Math.round(noahCash * 100) - Math.round(reserve * 100)) / 100);
  const plannedSpend = Math.min(budget, cents(fullNeed));
  const scale = fullNeed > 0 ? Math.min(1, plannedSpend / fullNeed) : 0;
  const allocations = [Math.min(plannedSpend, cents(full[0] * scale)), 0];
  allocations[1] = cents(plannedSpend - allocations[0]);
  const afterTotal = total + plannedSpend;
  if (holdings.some((value, i) => allocations[i] > 0.01 && value / total >= TARGETS[i]
    && (value + allocations[i]) / afterTotal > TARGETS[i] + 1e-8)) {
    throw new Error('Limited cash would buy an already overweight class; use unavailable pending policy review');
  }
  return {
    status: 'snapshot', budget, fullNeed, full, plannedSpend, allocations,
    budgetUnused: cents(budget - plannedSpend), fundingShortfall: Math.max(0, fullNeed - plannedSpend),
    currentWeights: holdings.map(value => value / total),
    afterWeights: holdings.map((value, i) => (value + allocations[i]) / afterTotal),
    staticGaps: holdings.map((value, i) => Math.max(0, TARGETS[i] * total - value)),
    coverage: fullNeed > 0 ? budget / fullNeed : null,
  };
}

export function renderCashPlan(input) {
  const plan = calculateCashPlan(input);
  // Keep the existing decision template as the page's only HTML template.
  const template = `<!-- ${CASH_PLAN_ID}:${Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')} -->`;
  if (plan.status === 'unavailable') return {
    template,
    kpi: '<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big">待核实</div><div class="sub">缺少已核实的持仓或现金数据，暂不列金额；不影响其他报告内容。</div></div>',
    detail: '<section class="card" id="xuan-ib-cash-plan-detail"><h2>现金优先补仓参考</h2><p>本项数据待核实。不以零或旧数伪装新读数，不计未成交卖出回款，不生成交易指令。</p></section>',
  };
  const [d, e] = plan.allocations;
  const remaining = plan.fundingShortfall > 0.01 ? `此情景补足两类仍需约 ${money(plan.fundingShortfall)}` : '两类参考目标可覆盖；不代表四类全部达标';
  const kpi = `<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big num">${money(plan.plannedSpend)}</div><div class="sub">现金规划 · 非下单额度<br><b>① 非美发达 ${money(d)}</b><br><b>② 新兴市场 ${money(e)}</b><br>${remaining}<br>含跨平台资金，挂单占款待核<br>详见「配置」· 卖出回款后再算</div></div>`;
  const detail = `<section class="card" id="xuan-ib-cash-plan-detail">
<h2>现金优先补仓参考 <small>只作规划，不执行交易</small></h2>
<p style="font-size:12px">目标按股票总额计，不含现金；全部金额为美元（USD）。按现金池扣预留款规划，不依赖持仓卖出。金额是两类完整补足方案按预算同比例缩小的情景参考，不是已核实的券商下单额度。</p>
<div class="kv"><span class="k">① 非美发达 · EXUS 方向</span><span class="v"><b>${money(d)}</b><br>当前 ${percent(plan.currentWeights[0])} → 补后约 ${percent(plan.afterWeights[0])} / 目标 23%</span></div>
<div class="kv"><span class="k">② 新兴市场 · EIMI 方向</span><span class="v"><b>${money(e)}</b><br>当前 ${percent(plan.currentWeights[1])} → 补后约 ${percent(plan.afterWeights[1])} / 目标 12%</span></div>
<div class="kv"><span class="k">现金规划上限 / 本次参考分配</span><span class="v">${money(plan.budget)} / ${money(plan.plannedSpend)}${plan.budgetUnused > 0.01 ? `；余款 ${money(plan.budgetUnused)} 保留` : ''}</span></div>
<div class="kv"><span class="k">券商可立即用于本次补仓</span><span class="v"><b class="wv">待核实</b> · 未扣未核实的挂单占款；跨平台资金未假设已到账</span></div>
<p style="font-size:12px"><b>${remaining}。</b>回款时间未确定，不假设卖出，也不预先计入预算；成交、调拨到账或价格改变后按新持仓重算。此方案只改善上述两类，不代表四类全部回到目标。</p>
<details><summary>使用前核对 · 金额与口径 <span class="rt">默认折叠</span></summary><div class="dbody"><ol>
<li>先核实 IB 可用余额、现有买单占款及 reserve 所在账户；NOAH-HK 现金尚需确认能否及何时用于本次补仓。现金池不是 IB 即时购买力。</li>
<li>未成交卖单不计回款；“待撤”买单不等于已经撤销，不能当作资金已释放。未核实冻结口径时不重复扣减，也不把名义挂单金额当券商实际冻结金额。</li>
<li>规划预算＝IB ${money(input.ibCash)}＋NOAH-HK ${money(input.noahCash)}−预留 ${money(input.reserve)}。不含保证金、借款或待售资产。若实际可调动资金更少，应缩小预算重新计算。</li>
<li>股票分母原为 ${money(input.equityTotal)}，现金买入后增加。只买这两类使二者同时达标需约 ${money(plan.fullNeed)}，其中非美发达 ${money(plan.full[0])}、新兴 ${money(plan.full[1])}。现金池覆盖约 ${plan.coverage === null ? '不适用（无需补足）' : percent(plan.coverage)}。</li>
<li>固定股票分母的静态不足＝${money(plan.staticGaps[0] + plan.staticGaps[1])}；它不是现金买入的达标金额。预算不足时按完整补足额的比例分配；不改变现有目标，不属于新的 v9.6 授权，也不提供股数、限价或自动交易。</li>
<li>数据时点：${input.sourceAsOfHkt}。上述为该快照下的预算情景，不是未来成交承诺。</li>
</ol></div></details>
</section>`;
  return { kpi, detail, template };
}

export function validateCashPlan(html, { previousHtml = null } = {}) {
  const source = String(html ?? '');
  const previous = String(previousHtml ?? '');
  const required = source.includes(CASH_PLAN_ID) || previous.includes(CASH_PLAN_ID)
    || /四类[^<]{0,20}补仓缺口|动态缺口（纯新钱补入）/.test(source + '\n' + previous);
  if (!required) return [];
  const matches = [...source.matchAll(/<!-- xuan-ib-cash-plan-v1:([A-Za-z0-9_-]+) -->/g)];
  if (matches.length !== 1 || source.split(CASH_PLAN_ID).length !== 2) return ['cash plan requires exactly one canonical input comment'];
  try {
    const rendered = renderCashPlan(JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8')));
    for (const id of ['xuan-ib-cash-plan-kpi', 'xuan-ib-cash-plan-detail']) {
      const ids = [...source.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
      if (ids.filter(match => (match[1] ?? match[2] ?? match[3]) === id).length !== 1) return [`cash plan ${id} must be unique`];
    }
    for (const [name, markup] of Object.entries(rendered)) {
      if (source.split(markup).length !== 2) return [`cash plan ${name} differs from deterministic calculation/rendering`];
      if (name !== 'template') {
        const visible = source.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
        if (!visible.includes(markup)) return [`cash plan ${name} cannot be hidden in an inert container`];
      }
    }
    if (/动态缺口（纯新钱补入）|四类[^<]{0,20}补仓缺口合计/.test(source)) return ['cash plan cannot retain the old static-gap-as-cash-budget labels'];
    return [];
  } catch (error) { return [`cash plan invalid: ${error.message}`]; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/xuan-ib-cash-plan.mjs INPUT.json');
    process.stdout.write(JSON.stringify(renderCashPlan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
