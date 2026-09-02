// Pure fee and return engine used only by the trusted writer.  Every display,
// including the phone UI, consumes the writer's validated receipt instead of
// running this calculation again.  This module deliberately has no filesystem,
// clock, network, encryption, or browser dependencies.

const DAY_MS = 86400000;
const FLOW_CENT = 0.005;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isCalendarDate = value => {
  const match = DATE_RE.exec(String(value || ""));
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const number = value => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const dateMs = value => {
  if (!isCalendarDate(value)) throw new Error(`invalid calendar date ${String(value)}`);
  const parts = String(value).split("-").map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
};

const nextDate = value => new Date(dateMs(value) + DAY_MS).toISOString().slice(0, 10);

export const inclusiveDays = (from, to) => Math.round((dateMs(to) - dateMs(from)) / DAY_MS) + 1;

export const endOfMonth = ym => {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(ym))) throw new Error(`invalid month ${String(ym)}`);
  const [year, month] = String(ym).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

const nextMonth = ym => {
  let [year, month] = String(ym).split("-").map(Number);
  month += 1;
  if (month > 12) { month = 1; year += 1; }
  return `${year}-${String(month).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ *
 * Flow de-duplication. Keep this block behaviourally identical to the
 * flow-dedupe block in index.html until the UI-only migration in phase 2.
 * ------------------------------------------------------------------ */

const FLOW_STOP = new Set([
  "USD", "HKD", "CNY", "EUR", "IN", "KIND", "FOP", "TRANSFER", "TRANSFERS",
  "EXTERNAL", "ASSET", "FROM", "TO", "SHARES", "SHARE", "STOCK", "CASH",
  "DEPOSIT", "WITHDRAWAL", "THE", "AND", "OF", "VERIFIED", "INBOUND",
  "OUTBOUND", "CONTRIBUTION"
]);

function flowTokens(text) {
  const alpha = new Set(), numeric = new Set();
  const source = String(text == null ? "" : text).toUpperCase();
  for (const token of source.match(/[A-Z][A-Z0-9]*(?:[.\-]?[A-Z0-9]+)*/g) || []) {
    const compact = token.replace(/[^A-Z0-9]/g, "");
    if (compact.length >= 2 && !FLOW_STOP.has(token) && !FLOW_STOP.has(compact)) alpha.add(compact);
  }
  for (const token of source.match(/\d+(?:\.\d+)?/g) || []) numeric.add("#" + Number(token));
  return { alpha, numeric };
}

const intersects = (left, right) => {
  for (const value of left) if (right.has(value)) return true;
  return false;
};

function flowEvidence(left, right) {
  const a = flowTokens(left), b = flowTokens(right);
  const bothAlpha = a.alpha.size > 0 && b.alpha.size > 0;
  const bothNumeric = a.numeric.size > 0 && b.numeric.size > 0;
  const alphaMatch = bothAlpha && intersects(a.alpha, b.alpha);
  const numericMatch = bothNumeric && intersects(a.numeric, b.numeric);
  if ((bothAlpha && !alphaMatch) || (bothNumeric && !numericMatch)) return "conflict";
  return alphaMatch || numericMatch ? "match" : "none";
}

function flowDayGap(left, right) {
  const first = Date.parse(String(left || "") + "T00:00:00Z");
  const second = Date.parse(String(right || "") + "T00:00:00Z");
  if (!Number.isFinite(first) || !Number.isFinite(second)) return Number.NaN;
  return Math.abs(first - second) / DAY_MS;
}

function flowSameEvent(left, right, sameAccount) {
  if (Math.abs(number(left.amount) - number(right.amount)) > FLOW_CENT) return false;
  if ((String(left.acct || "") === String(right.acct || "")) !== sameAccount) return false;
  const gap = flowDayGap(left.date, right.date);
  if (!Number.isFinite(gap) || gap > 1) return false;
  const evidence = flowEvidence(left.note, right.note);
  if (evidence === "conflict") return false;
  if (!sameAccount) return evidence === "match";
  return gap > 0 ? evidence === "match" : true;
}

function flowPair(list, flow, pick) {
  let index = list.findIndex(value => pick(value) && flowSameEvent(pick(value), flow, true));
  if (index < 0) index = list.findIndex(value => pick(value) && flowSameEvent(pick(value), flow, false));
  return index;
}

export function effectiveFlows({ months = [], flowsAuto = [] } = {}) {
  const confirmed = months.flatMap(month => Array.isArray(month?.flows) ? month.flows : []);
  const confirmedSources = new Set(confirmed.map(flow => flow?.src).filter(Boolean));
  const pool = confirmed.filter(flow => flow && !flow.src).map(record => ({ record, used: false }));
  const kept = [], seenReason = new Set();

  for (const flow of flowsAuto) {
    if (!flow || flow.effective !== true) continue;
    const automatic = {
      id: flow.id,
      src: flow.id,
      date: flow.date,
      acct: flow.acct,
      amount: number(flow.amount),
      note: flow.desc || "",
      reason: flow.reason == null ? "" : flow.reason,
      automatic: true
    };
    const reasonKey = String(automatic.reason).trim();
    if (reasonKey) {
      if (seenReason.has(reasonKey)) continue;
      seenReason.add(reasonKey);
    }
    if (confirmedSources.has(flow.id)) continue;
    const index = flowPair(pool, automatic, value => value.used ? null : value.record);
    if (index >= 0) { pool[index].used = true; continue; }
    if (!reasonKey && flowPair(kept, automatic, value => value) >= 0) continue;
    kept.push(automatic);
  }
  return confirmed.concat(kept);
}

/* ------------------------------------------------------------------ *
 * One-period return and fee calculation.
 * ------------------------------------------------------------------ */

export function periodReturns(input) {
  const points = (input.points || []).slice().sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const benchmark = input.bench || [];
  const flowByDate = input.flowByDate || {};
  const to = input.to;
  const opening = input.openT;
  const days = Math.max(1, input.days);
  const rate = input.rate;
  const carryRate = input.cr;
  const cumulativeBefore = input.cumBefore;
  const highWaterBefore = input.hwmBefore;
  const benchmarkPrevious = input.bPrev || {};
  const benchmarkValues = input.bVal || {};
  const benchmarkHas = input.bHas || {};
  const issues = [], pointDates = new Set();

  for (const point of points) {
    if (!isCalendarDate(point.d) || point.d < input.from || point.d > to) issues.push("估值日期越界 " + point.d);
    if (pointDates.has(point.d)) issues.push("估值日期重复 " + point.d);
    pointDates.add(point.d);
    if (!(Number.isFinite(point.tot) && point.tot > 0)) issues.push("总资产无效 " + point.d);
  }
  for (let date = input.from; date <= to; date = nextDate(date)) {
    if (!pointDates.has(date)) issues.push("缺少每日估值 " + date);
  }

  let flowTotal = 0;
  for (const date of Object.keys(flowByDate)) {
    if (date < input.from || date > to) { issues.push("出入金日期越界 " + date); continue; }
    if (!Number.isFinite(flowByDate[date])) { issues.push("出入金金额无效 " + date); continue; }
    flowTotal += flowByDate[date];
    if (!pointDates.has(date)) issues.push("出入金当日缺少估值 " + date);
  }

  let dietzDenominator = opening;
  for (const date of Object.keys(flowByDate)) {
    if (date < input.from || date > to || !Number.isFinite(flowByDate[date])) continue;
    const elapsed = Math.max(0, Math.min(days, inclusiveDays(input.from, date)));
    dietzDenominator += flowByDate[date] * ((days - elapsed) / days);
  }
  if (!(dietzDenominator > 0)) issues.push("Modified Dietz 分母不为正");

  const benchmarkIndex = {}, benchmarkSeen = {};
  for (const item of benchmark) { benchmarkIndex[item.k] = 1; benchmarkSeen[item.k] = false; }
  let grossIndex = 1, grossPrevious = opening;
  const closing = points.length ? points.at(-1).tot : opening;
  const grossPnl = closing - opening - flowTotal;
  const feeBases = points.map(point => ({
    point,
    flow: flowByDate[point.d] || 0,
    basis: point.tot - (flowByDate[point.d] || 0)
  }));
  const mgmtValid = feeBases.length === days && feeBases.every(value => Number.isFinite(value.basis) && value.basis >= 0);
  for (const value of feeBases) {
    if (!(Number.isFinite(value.basis) && value.basis >= 0)) issues.push("管理费基数无效 " + value.point.d);
  }
  if (feeBases.length !== days) issues.push(`管理费计费点数 ${feeBases.length} 与日历天数 ${days} 不一致`);
  const feeBaseSum = mgmtValid ? feeBases.reduce((sum, value) => sum + value.basis, 0) : null;
  const averageFeeBase = mgmtValid ? feeBaseSum / feeBases.length : null;
  const managementFee = mgmtValid ? feeBaseSum * rate / 365 : null;
  const carry = Math.max(0, cumulativeBefore + grossPnl - highWaterBefore) * carryRate;
  const fees = managementFee == null ? null : managementFee + carry;
  const portfolioReady = issues.length === 0;

  if (portfolioReady) {
    for (const point of points) {
      const total = point.tot, flow = flowByDate[point.d] || 0;
      if (grossPrevious > 0) grossIndex *= (total - flow) / grossPrevious;
      grossPrevious = total;
    }
  }

  const benchmarkIssues = [];
  for (const item of benchmark) {
    if (!(benchmarkPrevious[item.k] > 0)) benchmarkIssues.push(item.k + " 缺少起算日前基准");
    for (const point of points) {
      if (!(point[item.k] > 0)) benchmarkIssues.push(item.k + " 缺少价格 " + point.d);
      if (item.dk && point[item.dk] !== undefined && (!(Number.isFinite(point[item.dk])) || point[item.dk] < 0)) {
        benchmarkIssues.push(item.dk + " 无效 " + point.d);
      }
    }
  }

  const benchmarkValid = input.benchmarkValid !== false && portfolioReady && benchmarkIssues.length === 0;
  let benchmarkValueValid = input.benchmarkValueValid !== false && benchmarkValid;
  const benchmarkValueIssues = [];
  if (benchmarkValid) {
    for (const point of points) {
      const flow = flowByDate[point.d] || 0;
      for (const item of benchmark) {
        const price = point[item.k], dividend = item.dk ? (point[item.dk] || 0) : 0;
        const dailyReturn = (price + dividend) / benchmarkPrevious[item.k] - 1;
        benchmarkIndex[item.k] *= 1 + dailyReturn;
        if (benchmarkValueValid) benchmarkValues[item.k] *= 1 + dailyReturn;
        benchmarkSeen[item.k] = true;
        benchmarkHas[item.k] = true;
        benchmarkPrevious[item.k] = price;
      }
      if (flow && benchmarkValueValid) {
        const bad = benchmark.find(item => !(Number.isFinite(benchmarkValues[item.k] + flow) && benchmarkValues[item.k] + flow >= 0));
        if (bad) {
          benchmarkValueIssues.push((bad.account || bad.k) + " 的提款超过被动账户价值 " + point.d);
          benchmarkValueValid = false;
        } else {
          for (const item of benchmark) benchmarkValues[item.k] += flow;
        }
      }
    }
  }
  const benchmarkReturns = {};
  for (const item of benchmark) benchmarkReturns[item.k] = benchmarkSeen[item.k] ? benchmarkIndex[item.k] - 1 : null;

  return {
    closeT: closing,
    flowT: flowTotal,
    den: dietzDenominator,
    pnl: grossPnl,
    mgmt: managementFee,
    carry,
    fees,
    feeBaseSum,
    averageFeeBase,
    feeBasisDayCount: feeBases.length,
    calendarDayCount: days,
    mgmtValid,
    rG: portfolioReady ? grossIndex - 1 : null,
    rD: portfolioReady && fees != null ? (grossPnl - fees) / dietzDenominator : null,
    rB: benchmarkReturns,
    benchmarkValid,
    benchmarkValueValid,
    issues: [...new Set(issues)],
    benchIssues: [...new Set(benchmarkIssues)],
    benchValueIssues: [...new Set(benchmarkValueIssues)]
  };
}

/* ------------------------------------------------------------------ *
 * Multi-period statement used to create a deterministic receipt.
 * ------------------------------------------------------------------ */

export function computeFeeStatement({ daily = [], flowsAuto = [], econ, asOf }) {
  if (!econ || typeof econ !== "object" || Array.isArray(econ)) throw new Error("economic input must be an object");
  const start = String(econ.settings?.start || "");
  if (!isCalendarDate(start)) throw new Error("economic input has an invalid start date");
  if (!isCalendarDate(asOf) || asOf < start) throw new Error("asOf must be a valid date on or after start");
  const rate = Number(econ.settings?.mgmt) / 100;
  const carryRate = Number(econ.settings?.carry) / 100;
  if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(carryRate) || carryRate < 0) {
    throw new Error("economic input has an invalid fee rate");
  }
  const accounts = Array.isArray(econ.accounts) ? econ.accounts : [];
  if (!accounts.length || accounts.some(account => !account?.id || !Number.isFinite(Number(account.opening)))) {
    throw new Error("economic input has invalid accounts");
  }
  const accountIds = accounts.map(account => String(account.id));
  if (new Set(accountIds).size !== accountIds.length) throw new Error("economic input has duplicate accounts");
  const openingTotal = accounts.reduce((sum, account) => sum + Number(account.opening), 0);
  if (!(openingTotal > 0)) throw new Error("economic input opening total must be positive");

  const points = daily
    .filter(point => point && isCalendarDate(String(point.d)) && point.d >= start && point.d <= asOf)
    .map(point => ({
      d: point.d,
      tot: accountIds.reduce((sum, id) => sum + number(point[id]), 0)
    }))
    .sort((left, right) => left.d.localeCompare(right.d));
  if (!points.length || points.at(-1).d !== asOf) throw new Error("daily input does not cover asOf");

  const flows = effectiveFlows({ months: econ.months || [], flowsAuto })
    .filter(flow => flow && flow.date >= start && flow.date <= asOf);
  const rows = [];
  let opening = openingTotal, cumulative = 0, highWater = 0;

  for (let ym = start.slice(0, 7); ym <= asOf.slice(0, 7); ym = nextMonth(ym)) {
    const from = ym === start.slice(0, 7) ? start : ym + "-01";
    const to = ym === asOf.slice(0, 7) ? asOf : endOfMonth(ym);
    const periodPoints = points.filter(point => point.d >= from && point.d <= to);
    const periodFlows = flows.filter(flow => flow.date >= from && flow.date <= to);
    const flowByDate = {};
    for (const flow of periodFlows) flowByDate[flow.date] = (flowByDate[flow.date] || 0) + number(flow.amount);
    const result = periodReturns({
      points: periodPoints,
      openT: opening,
      from,
      to,
      days: inclusiveDays(from, to),
      flowByDate,
      rate,
      cr: carryRate,
      cumBefore: cumulative,
      hwmBefore: highWater,
      bench: [],
      bPrev: {},
      bVal: {},
      bHas: {}
    });
    if (result.issues.length || !result.mgmtValid || result.mgmt == null || result.fees == null) {
      throw new Error(`fee calculation failed for ${ym}: ${result.issues.join("; ") || "management fee unavailable"}`);
    }
    const highWaterBefore = highWater;
    const cumulativeBefore = cumulative;
    cumulative += result.pnl;
    if (cumulative > highWater) highWater = cumulative;
    rows.push({
      ym,
      from,
      to,
      opening: result.closeT - result.pnl - result.flowT,
      closing: result.closeT,
      flowTotal: result.flowT,
      grossPnl: result.pnl,
      feeBaseSum: result.feeBaseSum,
      averageFeeBase: result.averageFeeBase,
      managementFee: result.mgmt,
      dietzDenominator: result.den,
      carry: result.carry,
      totalFee: result.fees,
      grossTwr: result.rG,
      investorDietz: result.rD,
      feeBasisDayCount: result.feeBasisDayCount,
      calendarDayCount: result.calendarDayCount,
      mgmtValid: result.mgmtValid,
      cumulativeBefore,
      cumulativeAfter: cumulative,
      hwmBefore: highWaterBefore,
      hwmAfter: highWater
    });
    opening = result.closeT;
  }

  // `normalizeEconomicInputs` has already resolved every payment to a positive
  // USD FX rate.  Payments dated after the explicit asOf are not yet part of
  // this statement.
  const paid = (Array.isArray(econ.fees) ? econ.fees : [])
    .filter(fee => fee && fee.date >= start && fee.date <= asOf)
    .reduce((sum, fee) => sum + number(fee.amount) * number(fee.fx), 0);
  const accrued = rows.reduce((sum, row) => sum + row.totalFee, 0);
  const spanDays = inclusiveDays(start, asOf);
  let fullDietzDenominator = openingTotal;
  for (const flow of flows) {
    const elapsed = Math.max(0, Math.min(spanDays, inclusiveDays(start, flow.date)));
    fullDietzDenominator += number(flow.amount) * ((spanDays - elapsed) / spanDays);
  }
  if (!(fullDietzDenominator > 0)) throw new Error("full-period Modified Dietz denominator is not positive");
  const grossPnl = rows.reduce((sum, row) => sum + row.grossPnl, 0);
  const fees = accrued;
  const netPnl = grossPnl - fees;
  const grossTwr = rows.reduce((index, row) => index * (1 + row.grossTwr), 1) - 1;

  return {
    asOf,
    rows,
    flows,
    balance: { accrued, paid, due: accrued - paid },
    totals: {
      grossPnl,
      managementFee: rows.reduce((sum, row) => sum + row.managementFee, 0),
      carry: rows.reduce((sum, row) => sum + row.carry, 0),
      fees,
      netPnl,
      grossTwr,
      investorDietz: netPnl / fullDietzDenominator,
      dietzDenominator: fullDietzDenominator,
      spanDays
    }
  };
}
