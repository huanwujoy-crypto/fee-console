// Read-only indicative simulation. No account API, filesystem or trade capability.
export const TREND_METHOD = 'xuan-etf-indicative-v2';
export const ETF_WEIGHTS = Object.freeze({ CSPX: .60, EXUS: .23, EIMI: .12, USSC: .05 });
const symbols = Object.keys(ETF_WEIGHTS);
const EPS = 1e-7;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, message) => { if (!ok) throw new Error(message); };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const round = (v, digits = 8) => Number(v.toFixed(digits));
const copy = v => JSON.parse(JSON.stringify(v));

function validateInput(input) {
  check(object(input) && input.methodId === TREND_METHOD, 'Unsupported trend method');
  check(validDate(input.startDate) && validDate(input.frozenDate) && input.frozenDate >= input.startDate, 'Invalid baseline/freeze date');
  check(finite(input.initialUsd) && input.initialUsd > 0, 'Initial wealth must be positive');
  check(input.reserveUsd === 240000, 'The approved provisional reserve is USD 240,000');
  check(Array.isArray(input.days) && input.days.length > 0 && input.days.length <= 10000, 'Daily observations required');
  check(input.days[0].date === input.startDate, 'First observation must be the baseline');
  const events = new Set();
  for (const [i, day] of input.days.entries()) {
    check(validDate(day.date) && (!i || day.date > input.days[i - 1].date), 'Dates must be unique and ordered');
    // Include weekends too: silently omitting dates can lose flows and missing-price history.
    if (i) check(Date.parse(day.date) - Date.parse(input.days[i - 1].date) === 86400000, 'Daily calendar must be contiguous');
    check(finite(day.actualUsd) && day.actualUsd >= 0 || day.actualUsd === null, 'Invalid actual closing wealth');
    check(typeof day.actualComplete === 'boolean' && typeof day.flowsComplete === 'boolean', 'Source completeness required');
    check(Array.isArray(day.flows), 'Explicit cash-flow list required');
    check(object(day.quotes), 'Quote evidence required');
    check(typeof day.sourceRef === 'string' && day.sourceRef.length > 0 && day.sourceRef.length <= 500, 'Source reference required');
    for (const f of day.flows) {
      check(object(f) && typeof f.id === 'string' && f.id.length > 0 && !events.has(f.id), 'Duplicate or missing flow identity');
      check(f.date === day.date && finite(f.usd), 'Flow must retain its economic date and amount');
      check(['external', 'scope-in', 'scope-out'].includes(f.kind), 'Internal trades/income are not external flows');
      check(f.kind !== 'scope-in' || f.usd >= 0, 'Scope inflow sign');
      check(f.kind !== 'scope-out' || f.usd <= 0, 'Scope outflow sign');
      events.add(f.id);
    }
    if (!i) check(day.flows.length === 0 && day.actualUsd === input.initialUsd && day.actualComplete && day.flowsComplete, 'Baseline must be complete and after all pre-baseline flows');
    for (const s of symbols) {
      const q = day.quotes[s];
      check(object(q) && ['close', 'closed', 'missing'].includes(q.status), `Missing market status: ${s}`);
      if (q.status === 'close') {
        check(finite(q.usd) && q.usd > 0 && q.date === day.date, `Invalid closing quote: ${s}`);
        check(typeof q.source === 'string' && q.source.length > 0, `Quote source required: ${s}`);
      } else {
        check(q.usd === undefined && q.date === undefined, 'Carried values must be derived, not self asserted');
      }
      if (!i) check(q.status === 'close', 'No future or carried price may establish the baseline');
    }
  }
}

const valuation = (state, prices) => state.cash + symbols.reduce((v, s) => v + state.units[s] * prices[s], 0);
function invest(state, prices, weights, reserve) {
  const available = Math.max(0, state.cash - reserve);
  if (available <= EPS) return;
  for (const [s, weight] of Object.entries(weights)) state.units[s] += available * weight / prices[s];
  state.cash -= available;
}
function withdraw(state, amount, prices, canTrade, reserve) {
  const available = Math.max(0, state.cash - reserve);
  const cashUsed = Math.min(available, amount);
  state.cash -= cashUsed;
  let left = amount - cashUsed;
  const invested = symbols.reduce((v, s) => v + state.units[s] * prices[s], 0);
  if (left > EPS && invested > EPS) {
    check(canTrade, 'Withdrawal needs a real common closing price; interval pending');
    const sale = Math.min(left, invested);
    const fraction = sale / invested;
    for (const s of symbols) state.units[s] *= 1 - fraction;
    left -= sale;
  }
  check(left <= state.cash + EPS, 'Withdrawal exceeds wealth; no borrowing simulated');
  const reserveUsed = left > EPS;
  state.cash = Math.max(0, state.cash - left);
  return reserveUsed;
}

// Recompute from the immutable baseline and complete input history on every run.
// Thus a newly available quote never silently turns earlier estimates into verified data.
export function simulateEtfTrend(input) {
  validateInput(input);
  const prices = Object.fromEntries(symbols.map(s => [s, input.days[0].quotes[s].usd]));
  const quoteDates = Object.fromEntries(symbols.map(s => [s, input.startDate]));
  const missingAges = Object.fromEntries(symbols.map(s => [s, 0]));
  const blankUnits = () => Object.fromEntries(symbols.map(s => [s, 0]));
  let b = { cash: input.initialUsd, units: blankUnits() };
  let c = { cash: input.initialUsd, units: blankUnits() };
  invest(b, prices, ETF_WEIGHTS, input.reserveUsd);
  invest(c, prices, { CSPX: 1 }, 0);
  let previous = { A: input.initialUsd, B: input.initialUsd, C: input.initialUsd };
  const index = { A: 100, B: 100, C: 100 }, peaks = { ...index };
  const maxDrawdown = { A: 0, B: 0, C: 0 };
  let cumulativeFlow = 0, uncertainHistory = false, latestCompleteDate = input.startDate, stop = null;
  const rows = [];
  for (const [i, day] of input.days.entries()) {
    let estimated = !day.actualComplete || !day.flowsComplete, canTrade = true;
    for (const s of symbols) {
      const q = day.quotes[s];
      if (q.status === 'close') { prices[s] = q.usd; quoteDates[s] = day.date; missingAges[s] = 0; }
      else canTrade = false;
      if (q.status === 'missing') { missingAges[s]++; estimated = true; }
      // A known holiday is not an additional missed trading day.
      if (missingAges[s] > 0) estimated = true;
    }
    if (symbols.some(s => missingAges[s] > 2) || day.actualUsd === null || !day.flowsComplete) {
      stop = { date: day.date, reason: !day.flowsComplete ? '现金流待核，保留上期' : '数据缺项，保留已有曲线' }; break;
    }
    const flow = day.flows.reduce((sum, f) => sum + f.usd, 0);
    const before = { A: day.actualUsd - flow, B: valuation(b, prices), C: valuation(c, prices) };
    if (Object.values(before).some(v => v < -EPS) || (i && Object.values(previous).some(v => v <= EPS))) {
      stop = { date: day.date, reason: '资产为零或流量超出范围，需要新比较区间' }; break;
    }
    const nextB = copy(b), nextC = copy(c);
    let reserveUsed = false;
    try {
      if (flow >= 0) { nextB.cash += flow; nextC.cash += flow; }
      else {
        reserveUsed = withdraw(nextB, -flow, prices, canTrade, input.reserveUsd);
        withdraw(nextC, -flow, prices, canTrade, 0);
      }
      if (canTrade) { invest(nextB, prices, ETF_WEIGHTS, input.reserveUsd); invest(nextC, prices, { CSPX: 1 }, 0); }
    } catch (error) { stop = { date: day.date, reason: error.message }; break; }
    b = nextB; c = nextC;
    cumulativeFlow += flow;
    const ending = { A: day.actualUsd, B: valuation(b, prices), C: valuation(c, prices) };
    for (const arm of ['A', 'B', 'C']) {
      check(Math.abs(ending[arm] - (before[arm] + flow)) < .005, 'Conservation check failed');
      if (i) index[arm] *= before[arm] / previous[arm];
      peaks[arm] = Math.max(peaks[arm], index[arm]);
      maxDrawdown[arm] = Math.max(maxDrawdown[arm], 1 - index[arm] / peaks[arm]);
    }
    uncertainHistory ||= estimated;
    if (!uncertainHistory) latestCompleteDate = day.date;
    rows.push({ date: day.date, estimated, historyEstimated: uncertainHistory,
      retrospective: day.date < input.frozenDate, canTrade, reserveUsed,
      index: copy(index), endingUsd: ending, cumulativeFlowUsd: cumulativeFlow,
      gainUsd: Object.fromEntries(Object.entries(ending).map(([arm, v]) => [arm, v - input.initialUsd - cumulativeFlow])),
      maxDrawdown: copy(maxDrawdown), quoteDates: { ...quoteDates }, sourceRef: day.sourceRef });
    previous = ending;
  }
  return { methodId: TREND_METHOD, startDate: input.startDate, frozenDate: input.frozenDate,
    initialUsd: input.initialUsd, latestCompleteDate, rows, stop };
}

// Legacy full projection stays private. The separately approved open display
// below has its own smaller allowlist; never publish the original result.
export function projectEtfTrend(result) {
  check(result.methodId === TREND_METHOD && result.rows.length > 0, 'Computed result required');
  return { schemaVersion: 2, methodId: TREND_METHOD, startDate: result.startDate, frozenDate: result.frozenDate,
    latestCompleteDate: result.latestCompleteDate, stoppedAt: result.stop?.date || null,
    rows: result.rows.map(r => ({ date: r.date, estimated: r.estimated || r.historyEstimated,
      retrospective: r.retrospective, reserveUsed: r.reserveUsed, quoteDates: { ...r.quoteDates },
      index: Object.fromEntries(Object.entries(r.index).map(([a, v]) => [a, round(v, 6)])),
      relativeWealth: Object.fromEntries(Object.entries(r.endingUsd).map(([a, v]) => [a, round(v / result.initialUsd * 100, 6)])),
      maxDrawdown: Object.fromEntries(Object.entries(r.maxDrawdown).map(([a, v]) => [a, round(v, 8)])) })) };
}

export function validateTrendProjection(data) {
  return validateTrend(data, false);
}

function validateTrend(data, open) {
  const keys = (v, expected) => check(object(v) && Object.keys(v).sort().join(',') === expected.split(',').sort().join(','), 'Unexpected public field');
  keys(data, 'schemaVersion,methodId,startDate,frozenDate,latestCompleteDate,stoppedAt,rows' + (open ? ',purpose,latestBalances' : ''));
  check(data.schemaVersion === (open ? 3 : 2) && data.methodId === TREND_METHOD && validDate(data.startDate) && validDate(data.frozenDate)
    && data.frozenDate >= data.startDate && validDate(data.latestCompleteDate), 'Invalid public method/date');
  check(data.stoppedAt === null || validDate(data.stoppedAt), 'Invalid stop date');
  check(Array.isArray(data.rows) && data.rows.length > 0 && data.rows.length <= 10000, 'Invalid public rows');
  let seenEstimate = false, complete = data.startDate;
  const peaks = {A:100,B:100,C:100}, drawdowns = {A:0,B:0,C:0};
  for (const [i, r] of data.rows.entries()) {
    keys(r, 'date,estimated,retrospective,reserveUsed,quoteDates,index,maxDrawdown' + (open ? '' : ',relativeWealth'));
    check(validDate(r.date) && (i ? Date.parse(r.date) - Date.parse(data.rows[i - 1].date) === 86400000 : r.date === data.startDate), 'Invalid public order');
    check(typeof r.estimated === 'boolean' && typeof r.reserveUsed === 'boolean' && r.retrospective === (r.date < data.frozenDate), 'Invalid public status');
    keys(r.quoteDates, symbols.join(','));
    check(Object.values(r.quoteDates).every(d => validDate(d) && d >= data.startDate && d <= r.date), 'Invalid price date');
    if (i) check(symbols.every(s => r.quoteDates[s] >= data.rows[i-1].quoteDates[s]), 'Price dates cannot roll back');
    for (const field of open ? ['index', 'maxDrawdown'] : ['index', 'relativeWealth', 'maxDrawdown']) {
      keys(r[field], 'A,B,C');
      check(Object.values(r[field]).every(v => finite(v) && v >= 0 && v < 1e9), 'Invalid public metric');
    }
    check(Object.values(r.maxDrawdown).every(v => v <= 1), 'Invalid drawdown');
    for (const a of ['A','B','C']) {
      peaks[a] = Math.max(peaks[a], r.index[a]);
      drawdowns[a] = Math.max(drawdowns[a], 1-r.index[a]/peaks[a]);
      check(Math.abs(drawdowns[a]-r.maxDrawdown[a]) < 2e-7, 'Drawdown must match the index path');
    }
    if (!i) check(!r.estimated && Object.values(r.index).every(v => v === 100) && (open || Object.values(r.relativeWealth).every(v => v === 100)), 'Invalid normalized baseline');
    check(!seenEstimate || r.estimated, 'Cannot silently verify earlier estimates');
    seenEstimate ||= r.estimated;
    if (!seenEstimate) complete = r.date;
  }
  check(complete === data.latestCompleteDate, 'Complete date mismatch');
  check(data.stoppedAt === null || data.stoppedAt > data.rows.at(-1).date, 'Stop date must follow history');
  if (open) {
    check(data.purpose === 'xuan-etf-open-comparison', 'Invalid open comparison purpose');
    keys(data.latestBalances, 'date,usd'); keys(data.latestBalances.usd, 'A,B,C');
    check(data.latestBalances.date === data.latestCompleteDate, 'Balances must use the last complete date');
    check(Object.values(data.latestBalances.usd).every(v => finite(v) && v >= 0 && v < 1e15), 'Invalid comparison balance');
  }
  return data;
}

export function validateOpenEtfTrend(data, {now = new Date(), maxSeenDate = null} = {}) {
  validateTrend(data, true);
  check(now instanceof Date && Number.isFinite(now.getTime()), 'Invalid current date');
  const day = zone => {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  const today = day('Asia/Hong_Kong'), sourceDate = data.rows.at(-1).date;
  check([data.startDate,data.frozenDate,data.latestCompleteDate,sourceDate,...(data.stoppedAt ? [data.stoppedAt] : [])].every(d => d <= today), 'Future ETF date');
  check(sourceDate <= day('America/New_York'), 'Future ETF business date');
  check(maxSeenDate === null || (validDate(maxSeenDate) && maxSeenDate <= today && sourceDate >= maxSeenDate), 'Invalid or older ETF source date');
  return data;
}

// Call only after validating/replaying the private source. Explicitly omit all
// source references, relative wealth, flows, holdings, keys and original inputs.
export function projectOpenEtfTrend(result, options = {}) {
  const p = projectEtfTrend(result), complete = result.rows.find(r => r.date === p.latestCompleteDate);
  const data = {schemaVersion:3,purpose:'xuan-etf-open-comparison',methodId:p.methodId,
    startDate:p.startDate,frozenDate:p.frozenDate,latestCompleteDate:p.latestCompleteDate,stoppedAt:p.stoppedAt,
    rows:p.rows.map(r => ({date:r.date,estimated:r.estimated,retrospective:r.retrospective,reserveUsed:r.reserveUsed,
      quoteDates:{...r.quoteDates},index:{...r.index},maxDrawdown:{...r.maxDrawdown}})),
    latestBalances:{date:p.latestCompleteDate,usd:{A:complete?.endingUsd.A,B:complete?.endingUsd.B,C:complete?.endingUsd.C}}};
  return validateOpenEtfTrend(data, options);
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { A: 'A 实际', B: 'B 建议模拟', C: 'C 标普500' };
const colors = { A: '#246ac4', B: '#8b4ab8', C: '#555f6d' };
export function renderEtfTrend(data, { privateResult = null } = {}) {
  const open = data?.schemaVersion === 3;
  if (open) validateOpenEtfTrend(data); else validateTrendProjection(data);
  const rows = data.rows, last = rows.at(-1), full = rows.find(r => r.date === data.latestCompleteDate);
  const values = rows.flatMap(r => Object.values(r.index));
  const lo = Math.min(100, ...values) - .25, hi = Math.max(100, ...values) + .25;
  const x = i => 32 + (rows.length > 1 ? i / (rows.length - 1) : 0) * 318;
  const y = v => 172 - (v - lo) / (hi - lo) * 144;
  const segments = [];
  for (const arm of ['C', 'B', 'A']) {
    if (rows.length === 1) segments.push(`<circle cx="32" cy="${y(100).toFixed(2)}" r="3" fill="${colors[arm]}"/>`);
    for (let i = 1; i < rows.length; i++) {
      const dashed = rows[i].estimated || arm === 'B' && rows[i - 1].retrospective;
      segments.push(`<path d="M${x(i - 1).toFixed(2)},${y(rows[i - 1].index[arm]).toFixed(2)} L${x(i).toFixed(2)},${y(rows[i].index[arm]).toFixed(2)}" fill="none" stroke="${colors[arm]}" stroke-width="2.5"${dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
    }
  }
  if (privateResult) check(!open && JSON.stringify(projectEtfTrend(privateResult)) === JSON.stringify(data), 'Amounts and chart must share the same result');
  const latest = open ? {endingUsd:data.latestBalances.usd} : privateResult?.rows.find(r => r.date === full.date);
  const fmt = v => new Intl.NumberFormat('zh-HK', { maximumFractionDigits: 0 }).format(v);
  const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  return `<section id="xuan-etf-trend-v2" class="card" style="font-size:16px;line-height:1.6"><h2 style="margin:0">ABC 表现比较</h2><p style="color:#68717d;margin:4px 0">${esc(data.startDate)} 收盘起算 · 数据至 ${esc(data.latestCompleteDate)}</p><div style="display:flex;gap:14px;flex-wrap:wrap">${['A', 'B', 'C'].map(a => `<span style="color:${colors[a]}">● ${names[a]}</span>`).join('')}</div><svg viewBox="0 0 380 205" role="img" aria-label="ABC 累计表现，起点为100；虚线为历史模拟或暂估" style="display:block;width:100%;max-width:760px"><line x1="32" y1="${y(100).toFixed(2)}" x2="350" y2="${y(100).toFixed(2)}" stroke="#bdc4cc" stroke-dasharray="2 3"/><text x="0" y="${(y(100) + 4).toFixed(2)}" font-size="12" fill="#647080">100</text>${segments.join('')}<text x="32" y="197" font-size="12" fill="#647080">${esc(data.startDate.slice(5))}</text><text x="350" y="197" text-anchor="end" font-size="12" fill="#647080">${esc(last.date.slice(5))}</text></svg>${last.estimated ? '<p style="color:#925800">虚线含暂估；下表保留最后完整数据。</p>' : ''}${data.stoppedAt ? `<p style="color:#925800">${esc(data.stoppedAt)} 起数据待补，已有历史保留。</p>` : ''}<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">方案</th><th style="text-align:right">累计表现</th><th style="text-align:right">${latest ? '估算余额 USD' : '相对余额'}</th></tr></thead><tbody>${['A', 'B', 'C'].map(a => `<tr><th style="text-align:left;padding:10px 0;border-top:1px solid #dde1e6;color:${colors[a]}">${names[a]}</th><td style="text-align:right;border-top:1px solid #dde1e6">${pct(full.index[a] - 100)}</td><td style="text-align:right;border-top:1px solid #dde1e6">${latest ? fmt(latest.endingUsd[a]) : full.relativeWealth[a].toFixed(2)}</td></tr>`).join('')}</tbody></table><details style="margin-top:12px"><summary>计算说明与回撤</summary><ol style="padding-left:24px"><li>曲线剔除出入金影响；余额含后续资金增减。${open ? '比较结果直接展示，仅用于趋势观察；不含账户明细。' : '比较数据属于私密信息，仅用于趋势观察。'}</li><li>B 为纸上目标组合；${esc(data.frozenDate)} 前是回溯模拟，虚线并非实际调仓。原逐步换仓版本保留。</li><li>B 假设留存24万美元，其余股票部分：CSPX60%、EXUS23%、EIMI12%、USSC5%。留存未证明CALL足额或资金可用。C全股票，两者风险不同。</li><li>无每日再平衡；B/C 不另估交易成本、个人税费和现金利息；A保留实际费用。基金价格内费用不重复扣除。</li><li>日终近似，市场收盘时间不同。${symbols.map(s=>`${s} 价格日 ${esc(last.quoteDates[s])}`).join('；')}。不作短期胜负或年化判断。</li><li>流量按可得账表核对；来源更正后从起点重算。本比较不是审计结算。</li><li>最大回撤：${['A', 'B', 'C'].map(a => `${a} ${(full.maxDrawdown[a] * 100).toFixed(2)}%`).join(' / ')}。</li>${rows.some(r => r.reserveUsed) ? '<li>模拟提款已触及假设现金留存，需另核CALL；没有实际交易。</li>' : ''}</ol></details></section>`;
}
