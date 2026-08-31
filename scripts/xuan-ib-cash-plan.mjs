import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CASH_PLAN_ID = 'xuan-ib-cash-plan-v1';
const TARGETS = [0.23, 0.12];
const INPUT_KEYS = ['schemaVersion', 'status', 'sourceAsOfHkt', 'equityTotal', 'developed', 'emerging', 'ibCash', 'noahCash', 'reserve', 'currency', 'denominator'];
const V2_INPUT_KEYS = [...INPUT_KEYS, 'usBase', 'ussc', 'usscBudgetShare'];
const APPROVED_USSC_BUDGET_SHARE = 0.10;
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
  if (input?.schemaVersion === 2) return calculateCashPlanV2(input);
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

// Version 2 is the approved three-way scenario, not a new strategic target.
// Reuse the unchanged v1 buy-only solver after the fixed USSC purchase enlarges
// the stock denominator. USSC is already inside usBase: never add it twice.
function calculateCashPlanV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !V2_INPUT_KEYS.includes(key))) throw new Error('Invalid cash-plan schema');
  if (input.status === 'unavailable') {
    if (Object.keys(input).some(key => !['schemaVersion', 'status'].includes(key))) throw new Error('Unavailable cash plan must not contain guessed inputs');
    return { status: 'unavailable' };
  }
  if (input.usscBudgetShare !== APPROVED_USSC_BUDGET_SHARE) throw new Error('USSC cash-budget share must match the approved 10% scenario, not a permanent portfolio target');
  for (const key of ['usBase', 'ussc']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1e12) throw new Error(`Invalid cash-plan input: ${key}`);
  }
  const legacyInput = Object.fromEntries(INPUT_KEYS.map(key => [key, key === 'schemaVersion' ? 1 : input[key]]));
  const baseline = calculateCashPlan(legacyInput);
  const { equityTotal: total, developed, emerging, usBase, ussc } = input;
  if (ussc > usBase || developed + emerging + usBase > total + Math.min(1, total * 1e-6)) {
    throw new Error('Cash-plan USSC must be inside US base and disjoint category totals must reconcile to the equity denominator');
  }
  const budget = baseline.budget;
  // Integer cents conserve the budget even for a one-cent planning balance.
  const budgetCents = Math.round(budget * 100);
  const usscCents = Math.round(budgetCents * APPROVED_USSC_BUDGET_SHARE);
  const usscAllocation = usscCents / 100;
  const developedEmergingBudget = (budgetCents - usscCents) / 100;
  if (budgetCents > 0 && baseline.fullNeed <= 0.01) {
    throw new Error('Three-way cash policy requires review when both target categories have no gap; use schema 2 unavailable and retain cash');
  }
  const de = calculateCashPlan({ ...legacyInput, equityTotal: total + usscAllocation, ibCash: developedEmergingBudget, noahCash: 0, reserve: 0 });
  if (budgetCents > 0 && developedEmergingBudget > cents(de.fullNeed)) {
    throw new Error('Three-way cash budget exceeds the two-category buy-only need; use schema 2 unavailable and retain surplus cash pending policy review');
  }
  const allocations = [...de.allocations, usscAllocation];
  const plannedSpend = (Math.round(de.plannedSpend * 100) + usscCents) / 100;
  const afterTotal = total + plannedSpend;
  if ([developed, emerging].some((value, i) => allocations[i] > 0.01 && value / total >= TARGETS[i]
      && (value + allocations[i]) / afterTotal > TARGETS[i] + 1e-8)) {
    throw new Error('Limited cash would buy an already overweight class; use schema 2 unavailable pending policy review');
  }
  return {
    status: 'snapshot', schemaVersion: 2, budget, plannedSpend, allocations,
    usscBudgetShare: APPROVED_USSC_BUDGET_SHARE, usscAllocation, developedEmergingBudget,
    budgetUnused: cents(budget - plannedSpend), afterTotal,
    fullNeed: de.fullNeed, full: de.full, fundingShortfall: Math.max(0, de.fullNeed - de.plannedSpend),
    currentWeights: [developed, emerging, ussc].map(value => value / total),
    afterWeights: [developed, emerging, ussc].map((value, i) => (value + allocations[i]) / afterTotal),
    usBaseCurrentWeight: usBase / total, usBaseAfterWeight: (usBase + usscAllocation) / afterTotal,
    staticGaps: baseline.staticGaps, coverage: de.coverage,
  };
}

function renderCashPlanV2(input, plan, template) {
  if (plan.status === 'unavailable') return {
    template,
    kpi: '<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big">待核实</div><div class="sub">EXUS · EIMI · USSC<br>暂不分配 · 详见「配置」</div></div>',
    detail: '<section class="card" id="xuan-ib-cash-plan-detail"><h2>现金优先补仓参考</h2><p>① EXUS｜非美发达、② EIMI｜新兴市场、③ USSC｜美国小盘价值：数据或适用条件待核实，暂不分配现金；不影响其他报告内容。</p><p>三方向方案须以已核实的同口径持仓及现金重新计算。USSC 的 10% 仅为本次补仓预算的参考比例，不是持仓目标；不使用旧数或零值替代缺失数据，不预计卖出回款，不生成交易指令。</p></section>',
  };
  const [d, e, u] = plan.allocations;
  const remaining = plan.fundingShortfall > 0.01 ? `两类仍需 ${money(plan.fundingShortfall)}` : '两类参考目标可覆盖';
  const kpi = `<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big num">${money(plan.plannedSpend)}</div><div class="sub">现金规划 · 非下单额度<br><b>EXUS ${money(d)}</b><br><b>EIMI ${money(e)}</b><br><b>USSC ${money(u)}</b><br>${remaining}<br>详见「配置」</div></div>`;
  const detail = `<section class="card" id="xuan-ib-cash-plan-detail">
<h2>现金优先补仓参考 <small>只作规划，不执行交易</small></h2>
<p style="font-size:12px">三方向补充 · USSC 占本次预算 10%，其余重算 EXUS、EIMI；不是永久持仓比例。金额为美元规划值，非下单额度。</p>
<div class="kv"><span class="k">① EXUS｜非美发达</span><span class="v"><b>${money(d)}</b><br>EXUS＋VCN 类别合计<br>当前 ${percent(plan.currentWeights[0])} → 补后约 ${percent(plan.afterWeights[0])} / 目标 23%</span></div>
<div class="kv"><span class="k">② EIMI｜新兴市场</span><span class="v"><b>${money(e)}</b><br>EIMI＋INDA 类别合计<br>当前 ${percent(plan.currentWeights[1])} → 补后约 ${percent(plan.afterWeights[1])} / 目标 12%</span></div>
<div class="kv"><span class="k">③ USSC｜美国小盘价值</span><span class="v"><b>${money(u)}</b><br>本次现金预算 10%<br>占股票总额：${percent(plan.currentWeights[2])} → 补后约 ${percent(plan.afterWeights[2])}</span></div>
<div class="kv"><span class="k">美国底仓合计（含 USSC）</span><span class="v">${percent(plan.usBaseCurrentWeight)} → 补后约 ${percent(plan.usBaseAfterWeight)}<br>45% 为参考目标，非强制上限</span></div>
<div class="kv"><span class="k">现金规划上限 / 本次参考分配</span><span class="v">${money(plan.budget)} / ${money(plan.plannedSpend)}${plan.budgetUnused > 0.01 ? `；余款 ${money(plan.budgetUnused)} 保留` : ''}</span></div>
<div class="kv"><span class="k">券商可立即用于本次补仓</span><span class="v"><b class="wv">待核实</b> · 挂单占款待核；跨平台资金未假设已到账</span></div>
<p style="font-size:12px"><b>${remaining}。</b>指在本次三方向分配后，以纯现金继续补足非美发达、新兴市场参考目标的金额；不是 USSC 缺口，也不代表四类全部达标。卖出回款实际可用后再评估；本次不依赖卖出。</p>
<details><summary>使用前核对 · 金额与口径 <span class="rt">默认折叠</span></summary><div class="dbody"><ol>
<li>先核实 IB 可用余额、现有买单占款及 reserve 所在账户；NOAH-HK 现金尚需确认能否及何时用于本次补仓。现金池不是 IB 即时购买力。</li>
<li>未成交卖单不计回款；“待撤”买单不等于已经撤销，不能当作资金已释放。未核实冻结口径时不重复扣减，也不把名义挂单金额当券商实际冻结金额。</li>
<li>规划预算＝IB ${money(input.ibCash)}＋NOAH-HK ${money(input.noahCash)}−预留 ${money(input.reserve)}，共 ${money(plan.budget)}。不含保证金、借款或待售资产；实际可用资金更少时，应按新预算重算三个金额。</li>
<li>USSC 先分配本次预算 10%，按美分取整为 ${money(u)}；剩余 ${money(plan.developedEmergingBudget)} 用于 EXUS、EIMI。其参考目标按类别合计计，不是单只 ETF 目标；USSC 的 10% 不是股票仓位目标，不设未经核实的 14% 目标分母。</li>
<li>原股票总额 ${money(input.equityTotal)}。先纳入 USSC 分配后，只补非美发达、新兴市场至 23%／12% 同时达标仍需 ${money(plan.fullNeed)}，其中 ${money(plan.full[0])}／${money(plan.full[1])}；以剩余预算按这两个完整补足额的比例分配，并按美分平衡。并非将旧方案直接打九折。</li>
<li>本次补仓后的股票总额＝原股票总额＋实际规划分配，共 ${money(plan.afterTotal)}。USSC 原持仓 ${money(input.ussc)} 已包含于美国底仓 ${money(input.usBase)}，不重复计入；现金本身不计入股票分母。45% 仅作美国底仓参考目标，不构成强制上限。</li>
<li>资金超出本方案两类需求、两类均无需补充或有限现金将继续买入超配类别时，暂列待核实并保留现金，不擅自扩展 USSC 预算或花完余款。</li>
<li>数据时点：${input.sourceAsOfHkt}。价格、持仓或可用现金改变后重新计算；不提供股数、限价或自动交易，不保证此配置收益更高。</li>
</ol></div></details>
</section>`;
  return { kpi, detail, template };
}

export function renderCashPlan(input) {
  const plan = calculateCashPlan(input);
  // Keep the existing decision template as the page's only HTML template.
  const template = `<!-- ${CASH_PLAN_ID}:${Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')} -->`;
  if (input.schemaVersion === 2) return renderCashPlanV2(input, plan, template);
  if (plan.status === 'unavailable') return {
    template,
    kpi: '<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big">待核实</div><div class="sub">缺少已核实的持仓或现金数据，暂不列金额；不影响其他报告内容。</div></div>',
    detail: '<section class="card" id="xuan-ib-cash-plan-detail"><h2>现金优先补仓参考</h2><p>① EXUS｜非美发达、② EIMI｜新兴市场：金额待核实。</p><p>③ USSC｜美国小盘价值：待回款后重算，不占本次现金预算。</p><p>不以零或旧数伪装新读数，不计未成交卖出回款，不生成交易指令。</p></section>',
  };
  const [d, e] = plan.allocations;
  const remaining = plan.fundingShortfall > 0.01 ? `此情景补足两类仍需约 ${money(plan.fundingShortfall)}` : '两类参考目标可覆盖；不代表四类全部达标';
  const compactRemaining = plan.fundingShortfall > 0.01 ? `补足两类仍需 ${money(plan.fundingShortfall)}` : '两类参考目标可覆盖';
  const kpi = `<div class="kpi" id="xuan-ib-cash-plan-kpi"><div class="lab">补仓指引 · 现金优先</div><div class="big num">${money(plan.plannedSpend)}</div><div class="sub">现金规划 · 非下单额度<br><b>EXUS ${money(d)}</b><br><b>EIMI ${money(e)}</b><br>USSC 待回款后重算<br>${compactRemaining}<br>详见「配置」</div></div>`;
  const detail = `<section class="card" id="xuan-ib-cash-plan-detail">
<h2>现金优先补仓参考 <small>只作规划，不执行交易</small></h2>
<p style="font-size:12px">现金优先 · 金额为美元规划值，非下单额度。比例是类别合计，非单只 ETF 目标。</p>
<div class="kv"><span class="k">① EXUS｜非美发达</span><span class="v"><b>${money(d)}</b><br>EXUS＋VCN 类别合计<br>当前 ${percent(plan.currentWeights[0])} → 补后约 ${percent(plan.afterWeights[0])} / 目标 23%</span></div>
<div class="kv"><span class="k">② EIMI｜新兴市场</span><span class="v"><b>${money(e)}</b><br>EIMI＋INDA 类别合计<br>当前 ${percent(plan.currentWeights[1])} → 补后约 ${percent(plan.afterWeights[1])} / 目标 12%</span></div>
<div class="kv"><span class="k">③ USSC｜美国小盘价值</span><span class="v"><b>待回款后重算</b><br>底仓调整回款为辅 · 不占本次现金预算</span></div>
<div class="kv"><span class="k">现金规划上限 / 本次参考分配</span><span class="v">${money(plan.budget)} / ${money(plan.plannedSpend)}${plan.budgetUnused > 0.01 ? `；余款 ${money(plan.budgetUnused)} 保留` : ''}</span></div>
<div class="kv"><span class="k">券商可立即用于本次补仓</span><span class="v"><b class="wv">待核实</b> · 未扣未核实的挂单占款；跨平台资金未假设已到账</span></div>
<p style="font-size:12px"><b>${remaining}。</b>回款时间未确定，不假设卖出，也不预先计入预算；成交、调拨到账或价格改变后按新持仓重算。此方案只改善上述两类，不代表四类全部回到目标。</p>
<details><summary>使用前核对 · 金额与口径 <span class="rt">默认折叠</span></summary><div class="dbody"><ol>
<li>先核实 IB 可用余额、现有买单占款及 reserve 所在账户；NOAH-HK 现金尚需确认能否及何时用于本次补仓。现金池不是 IB 即时购买力。</li>
<li>未成交卖单不计回款；“待撤”买单不等于已经撤销，不能当作资金已释放。未核实冻结口径时不重复扣减，也不把名义挂单金额当券商实际冻结金额。</li>
<li>规划预算＝IB ${money(input.ibCash)}＋NOAH-HK ${money(input.noahCash)}−预留 ${money(input.reserve)}。不含保证金、借款或待售资产。若实际可调动资金更少，应缩小预算重新计算。</li>
<li>股票分母原为 ${money(input.equityTotal)}，现金买入后增加。只买这两类使二者同时达标需约 ${money(plan.fullNeed)}，其中非美发达 ${money(plan.full[0])}、新兴 ${money(plan.full[1])}。现金池覆盖约 ${plan.coverage === null ? '不适用（无需补足）' : percent(plan.coverage)}。</li>
<li>固定股票分母的静态不足＝${money(plan.staticGaps[0] + plan.staticGaps[1])}；它不是现金买入的达标金额。目标按股票总额计，不含现金。按现金池扣预留款规划，不依赖持仓卖出；预算不足时按完整补足额的比例分配，仅为规划情景。不改变现有目标，不属于新的 v9.6 授权，也不提供股数、限价或自动交易。</li>
<li>数据时点：${input.sourceAsOfHkt}。上述为该快照下的预算情景，不是未来成交承诺。</li>
<li>23% 是非美发达类别（EXUS＋VCN）目标，12% 是新兴市场类别（EIMI＋INDA）目标，并非单只 ETF 目标。USSC 属美国底仓内部调整，卖出回款实际可用后另行重算；未给它分配本次现金，也未新增目标或交易指令。</li>
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
    const input = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
    if (previous.includes(CASH_PLAN_ID)) {
      const previousMatches = [...previous.matchAll(/<!-- xuan-ib-cash-plan-v1:([A-Za-z0-9_-]+) -->/g)];
      if (previousMatches.length !== 1 || previous.split(CASH_PLAN_ID).length !== 2) return ['previous cash plan requires exactly one canonical input comment'];
      const previousInput = JSON.parse(Buffer.from(previousMatches[0][1], 'base64url').toString('utf8'));
      // An unavailable schema-2 report still carries the approved minimum
      // version. Hiding/removing markup must not make the old policy legal.
      if (previousInput.schemaVersion === 2 && input.schemaVersion !== 2) return ['cash plan cannot downgrade the approved three-way schema 2 policy'];
    }
    const rendered = renderCashPlan(input);
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
