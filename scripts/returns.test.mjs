/**
 * 收益率口径 v4.6.1 的回归测试。
 *
 * 本文件用完全合成、不对应任何账户的数字钉住三件事：
 *   1. 口径 §9 写「时间加权」，实现就必须是逐日 TWR，不能回退成
 *      逐月 Modified Dietz。合成场景故意把较多收益放在流入后，使两种方法明显分开。
 *   2. 出入金的在场天数差一天：转入按 8/20 收盘价计价，当天吃不到行情，只在场
 *      8/21–8/24 共 4 天；旧代码曾按 5 天计权，系统性低估流入月的收益率。
 *   3. 基准按欧洲收盘取价，与组合的美股收盘估值错位 0.9pp，大于当期跑赢幅度。
 *
 * 合成数字只服务于方法回归，不表示任何实际组合、持仓、交易或市场快照。
 *
 * periodReturns 由可信 writer 的纯引擎提供。手机迁移后只消费计算回执，
 * 不再保留或执行这套公式。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { periodReturns } from "./fee-engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const block = periodReturns.toString();
const annMatch = html.match(/function ann\(r,days\)\{([^}]*)\}/);
assert.ok(annMatch, "index.html must carry the annualisation helper");
const annualise = new Function("r", "days", annMatch[1]);
const versionMatch = html.match(/" · v(\d+)\.(\d+)\.(\d+)"/);
assert.ok(versionMatch, "index.html must carry a semantic UI version");
const versionCode = Number(versionMatch[1]) * 1e6 + Number(versionMatch[2]) * 1e3 + Number(versionMatch[3]);
const usesDailyEodFee = versionCode >= 4e6 + 6e3 + 1;

/* ---------------- 24 天合成场景 ---------------- */

const OPEN = 100000;
const TRANSFER = 24000; // 第 20 天收盘记账，只参与后续 4/24 的资金权重
const DATES = Array.from({ length: 24 }, (_, i) =>
  `2026-08-${String(i + 1).padStart(2, "0")}`);

// 组合仅在第 3 天涨 1%、第 24 天涨 3%；第 20 天只有收盘流入。
// 流入后的收益较高，因而 TWR 与 Modified Dietz 必然明显分开。
let syntheticNav = OPEN;
const TOTALS = DATES.map(d => {
  if (d === "2026-08-03") syntheticNav *= 1.01;
  if (d === "2026-08-20") syntheticNav += TRANSFER;
  if (d === "2026-08-24") syntheticNav *= 1.03;
  return [d, syntheticNav];
});

// 两条合成基准序列仅使用 SPY / QQQ 作为方法标签。
// 第 11/12 天分别模拟除息：价格下调与现金分红恰好抵消。
const SPY_PREV = 500;
const QQQ_PREV = 400;
const syntheticBenchmark = d => {
  const day = Number(d.slice(-2));
  const spy = day < 11 ? 500 : day < 24 ? 498 : 510;
  const qqq = day < 3 ? 400 : day < 12 ? 404 : day < 24 ? 402 : 412;
  return { spy, qqq, spyd: day === 11 ? 2 : 0, qqqd: day === 12 ? 2 : 0 };
};

const BENCH = [{ k: "spy", dk: "spyd" }, { k: "qqq", dk: "qqqd" }];

const points = TOTALS.map(([d, tot]) => ({ d, tot, ...syntheticBenchmark(d) }));

const august = (over = {}) => {
  const bPrev = { spy: SPY_PREV, qqq: QQQ_PREV };
  const bVal = { spy: OPEN, qqq: OPEN };
  const bHas = { spy: false, qqq: false };
  const out = periodReturns({
    points, openT: OPEN, from: "2026-08-01", to: "2026-08-24", days: 24,
    flowByDate: { "2026-08-20": TRANSFER },
    rate: 0.02, cr: 0.20, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: BENCH, bPrev, bVal, bHas, ...over,
  });
  return { ...out, bVal, bHas };
};

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${label}: got ${actual}, expected ${expected} ±${tol}`);

test("invalid returns never annualise to a real-looking zero", () => {
  assert.equal(annualise(null, 366), null);
  assert.equal(annualise(undefined, 366), null);
  assert.equal(annualise(Number.NaN, 366), null);
  assert.equal(annualise(0.10, 0), null);
  near(annualise(0.10, 365), 0.10, 1e-12, "有效年化");
});

/* ---------------- 费用链条：逐日 EOD pre-flow NAV 与口径 §3 / §4 一致 ---------------- */

test("gross gain excludes the synthetic EOD flow, and daily management fees match §3/§4", () => {
  const r = august();
  near(r.pnl, 4750, 0.01, "当月净收益（毛）");
  // 每日基数使用收盘总资产减去当日 EOD flow：8/20 的 24,000 入金从次日起计费。
  const dailyBases = 100000 * 2 + 101000 * 18 + 125000 * 3 + 128750;
  const endpointAverage = (OPEN + 128750) / 2 * 0.02 * 24 / 365;
  const expectedMgmt = usesDailyEodFee ? dailyBases * 0.02 / 365 : endpointAverage;
  near(r.mgmt, expectedMgmt, 0.01, "版本对应的管理费 §3");
  near(r.mgmt, usesDailyEodFee ? 138.18 : 150.41, 0.01, "管理费");
  near(r.carry, 950, 0.01, "Carry");
  near(r.fees, usesDailyEodFee ? 1088.18 : 1100.41, 0.02, "费用合计");
});

test("an EOD contribution starts accruing management fees on the following day", () => {
  const r = periodReturns({
    points: [
      { d: "2026-09-01", tot: 100 },
      { d: "2026-09-02", tot: 150 },
      { d: "2026-09-03", tot: 150 },
    ],
    openT: 100, from: "2026-09-01", to: "2026-09-03", days: 3,
    flowByDate: { "2026-09-02": 50 }, rate: 0.0365, cr: 0,
    cumBefore: 0, hwmBefore: 0, bench: [], bPrev: {}, bVal: {}, bHas: {},
  });
  // 基数 100 + (150−50) + 150；日费率 0.0365/365 = 0.0001。
  near(r.mgmt, usesDailyEodFee ? 0.035 : 0.0375, 1e-12, "EOD 入金版本门槛");
});

test("an EOD withdrawal still accrues on the pre-withdrawal NAV that day", () => {
  const r = periodReturns({
    points: [
      { d: "2026-09-01", tot: 100 },
      { d: "2026-09-02", tot: 60 },
      { d: "2026-09-03", tot: 60 },
    ],
    openT: 100, from: "2026-09-01", to: "2026-09-03", days: 3,
    flowByDate: { "2026-09-02": -40 }, rate: 0.0365, cr: 0,
    cumBefore: 0, hwmBefore: 0, bench: [], bPrev: {}, bVal: {}, bHas: {},
  });
  // 基数 100 + (60−(−40)) + 60。
  near(r.mgmt, usesDailyEodFee ? 0.026 : 0.024, 1e-12, "EOD 出金版本门槛");
});

test("v4.6.1 and later expose only decision-useful TWR metrics", () => {
  if (!usesDailyEodFee) return;
  assert.doesNotMatch(html, /扣费后 TWR|组合扣费后 TWR/);
  assert.doesNotMatch(block, /\brN\b|\bidxN\b|\bprevN\b/);
  assert.match(html, /SPY·含息 ETF TWR/);
  assert.match(html, /QQQ·含息 ETF TWR/);
  assert.match(html, /现金流匹配的被动账户期末值/);
  assert.match(html, /相同资金路径下的期末金额/);
});

/* ---------------- 1. 逐日 TWR，而不是逐月 Modified Dietz ---------------- */

test("the gross rate is a daily time-weighted chain", () => {
  const r = august();
  near(r.rG, 1.01 * 1.03 - 1, 1e-12, "投资收益率（逐日 TWR，扣费前）");
  // 逐月 Modified Dietz 会给 4.5673%；故意的时点差异让回归足够敏感。
  assert.ok(Math.abs(r.rG - (r.pnl / r.den)) > 0.005,
    "rG must not fall back to monthly Modified Dietz");
});

/* ---------------- 2. 出入金在场天数：4/24，不是 5/24 ---------------- */

test("a flow booked at its own close is out of the market that day", () => {
  const r = august();
  // 分母 = 100,000 + 24,000 × 4/24
  near(r.den, OPEN + TRANSFER * 4 / 24, 1e-12, "Modified Dietz 分母");
  assert.ok(Math.abs(r.den - (OPEN + TRANSFER * 5 / 24)) > 1,
    "the flow must not be credited with the day it was priced on");
});

test("the LP rate is Modified Dietz and converges on the true IRR", () => {
  const r = august();
  near(r.rD, usesDailyEodFee ? 0.035209826132771335 : 0.035092202318229716,
    1e-12, "出资方净收益率");
  // 同一合成现金流序列的数值求解 IRR 为 3.5112%，两种 money-weighted
  // 方法必须收敛。
  near(r.rD, 0.035111545404666544, 0.0001, "Modified Dietz vs IRR");
});

test("the LP rate carries the LP's own timing, so it is not a fee gap", () => {
  const r = august();
  // 合成流入后发生了较大涨幅，因此未扣费的资金加权择时效应为正；
  // Modified Dietz 仍含费用，不应拿它和组合毛 TWR 相减解释费用。
  near((r.pnl / r.den) - r.rG, 0.005373076923076918, 1e-12, "出资方择时效应");
  assert.ok(r.rD < r.pnl / r.den, "the LP rate must reflect accrued fees");
});

test("a flow on the first day is in the market for days-1", () => {
  const r = august({ flowByDate: { "2026-08-01": TRANSFER } });
  near(r.den, OPEN + TRANSFER * 23 / 24, 0.01, "首日流入的分母");
});

test("a flow on the last day earns nothing at all", () => {
  const r = august({ flowByDate: { "2026-08-24": TRANSFER } });
  near(r.den, OPEN, 0.01, "末日流入的分母");
});

/* ---------------- 3. 基准：美股收盘、含息逐日链 ---------------- */

test("benchmarks chain daily on US closes", () => {
  const r = august();
  near(r.rB.spy, (500 / 500) * ((498 + 2) / 500) * (510 / 498) - 1,
    1e-12, "S&P 500（SPY）");
  near(r.rB.qqq, (404 / 400) * ((402 + 2) / 404) * (412 / 402) - 1,
    1e-12, "纳斯达克100（QQQ）");
  near(r.rB.spy, 0.024096385542168752, 1e-12, "SPY 合成同期");
  near(r.rB.qqq, 0.03512437810945279, 1e-12, "QQQ 合成同期");
});

test("the synthetic outperformance is measured on a single valuation time", () => {
  const r = august();
  // 两条基准都使用与组合一致的收盘时点。
  assert.ok(r.rG - r.rB.spy > 0.015, "vs S&P 500");
  assert.ok(r.rG - r.rB.qqq > 0.005, "vs NASDAQ-100");
});

test("a dividend on its ex-date lifts the chain by exactly that amount", () => {
  const withDiv = periodReturns({
    points: [
      { d: "2026-09-17", tot: 100, spy: 100, spyd: 0 },
      { d: "2026-09-18", tot: 100, spy: 99, spyd: 1.5 },
    ],
    openT: 100, from: "2026-09-17", to: "2026-09-18", days: 2, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 100 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  // 除息日价格掉了 1，加回 1.5 的合成分红才是总回报。
  near(withDiv.rB.spy, (99 + 1.5) / 100 - 1, 1e-12, "含息链");
  assert.ok(withDiv.rB.spy > 0, "the total-return chain must survive the price drop");
});

test("a missing benchmark price makes the benchmark unavailable, never guessed", () => {
  const gap = periodReturns({
    points: [
      { d: "2026-08-01", tot: 100, spy: 100 },
      { d: "2026-08-02", tot: 100, spy: 0 },
      { d: "2026-08-03", tot: 100, spy: 101 },
    ],
    openT: 100, from: "2026-08-01", to: "2026-08-03", days: 3, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 100 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  assert.equal(gap.rB.spy, null);
  assert.ok(gap.benchIssues.some(x=>/缺少价格 2026-08-02/.test(x)), gap.benchIssues.join("; "));
});

test("a benchmark with no data at all reports null, not zero", () => {
  const none = periodReturns({
    points: [{ d: "2026-08-01", tot: 100 }],
    openT: 100, from: "2026-08-01", to: "2026-08-01", days: 1, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 0 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  assert.equal(none.rB.spy, null);
});

test("a benchmark gap is a one-way fuse and later prices cannot bridge it", () => {
  const bPrev = { spy: 100 }, bVal = { spy: 100 }, bHas = { spy: false };
  const missing = periodReturns({
    points: [{ d: "2026-08-01", tot: 100, spy: 0 }],
    openT: 100, from: "2026-08-01", to: "2026-08-01", days: 1, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }], bPrev, bVal, bHas, benchmarkValid: true,
  });
  assert.equal(missing.benchmarkValid, false);
  assert.equal(missing.rB.spy, null);

  const later = periodReturns({
    points: [{ d: "2026-08-02", tot: 100, spy: 101 }],
    openT: 100, from: "2026-08-02", to: "2026-08-02", days: 1, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }], bPrev, bVal, bHas,
    benchmarkValid: missing.benchmarkValid,
  });
  assert.equal(later.benchmarkValid, false);
  assert.equal(later.rB.spy, null);
  assert.equal(bHas.spy, false);
  assert.equal(bPrev.spy, 100, "the chain must not jump across the missing date");
});

/* ---------------- 现值对照：两侧对 flow 的处理必须对称 ---------------- */

test("the what-if-I-had-bought-the-index figure rolls the flow from its own date", () => {
  const r = august();
  // 流入按第 20 天收盘入账，之后才跟着基准涨跌。
  const spyFactor = (500 / 500) * ((498 + 2) / 500) * (510 / 498);
  const rolled = OPEN * spyFactor + TRANSFER * (510 / 498);
  const monthEnd = OPEN * spyFactor + TRANSFER; // 旧写法：flow 整月不吃基准收益
  near(r.bVal.spy, rolled, 1.0, "现金流匹配的 S&P 500 被动账户");
  assert.ok(Math.abs(rolled - monthEnd) > 300,
    "this month the two conventions must differ enough for the test to bite");
  assert.ok(Math.abs(r.bVal.spy - monthEnd) > 300,
    "the flow must not sit out the whole month on the benchmark side");
  const qqqFactor = (404 / 400) * ((402 + 2) / 404) * (412 / 402);
  near(r.bVal.qqq, OPEN * qqqFactor + TRANSFER * (412 / 402), 1.0,
    "现金流匹配的纳斯达克100被动账户");
});

test("the passive benchmark account matches an inflow and a later withdrawal across months", () => {
  if (!usesDailyEodFee) return;
  const bPrev = { spy: 100 }, bVal = { spy: 100 }, bHas = { spy: false };
  const september = periodReturns({
    points: [
      { d: "2026-09-29", tot: 100, spy: 100 },
      { d: "2026-09-30", tot: 150, spy: 110 },
    ],
    openT: 100, from: "2026-09-29", to: "2026-09-30", days: 2,
    flowByDate: { "2026-09-30": 50 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, bench: [{ k: "spy", dk: "spyd", account: "S&P 500（SPY）" }],
    bPrev, bVal, bHas, benchmarkValid: true, benchmarkValueValid: true,
  });
  near(bVal.spy, 160, 1e-12, "期初 100 上涨 10% 后 EOD 入金 50");
  assert.equal(september.benchmarkValueValid, true);

  const october = periodReturns({
    points: [
      { d: "2026-10-01", tot: 110, spy: 121 },
      { d: "2026-10-02", tot: 110, spy: 133.1 },
    ],
    openT: 150, from: "2026-10-01", to: "2026-10-02", days: 2,
    flowByDate: { "2026-10-01": -40 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, bench: [{ k: "spy", dk: "spyd", account: "S&P 500（SPY）" }],
    bPrev, bVal, bHas, benchmarkValid: september.benchmarkValid,
    benchmarkValueValid: september.benchmarkValueValid,
  });
  // 160 × 1.10 − 40，再从次日起取得 10% 收益。
  near(bVal.spy, 149.6, 1e-10, "跨月现金流匹配期末值");
  assert.equal(october.benchmarkValueValid, true);
});

test("an oversized withdrawal disables only the passive-account value, not benchmark TWR", () => {
  if (!usesDailyEodFee) return;
  const bVal = { spy: 70 };
  const r = periodReturns({
    points: [{ d: "2026-10-03", tot: 20, spy: 100 }],
    openT: 100, from: "2026-10-03", to: "2026-10-03", days: 1,
    flowByDate: { "2026-10-03": -80 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, bench: [{ k: "spy", dk: "spyd", account: "S&P 500（SPY）" }],
    bPrev: { spy: 100 }, bVal, bHas: { spy: false },
    benchmarkValid: true, benchmarkValueValid: true,
  });
  assert.equal(r.benchmarkValid, true);
  assert.equal(r.benchmarkValueValid, false);
  near(r.rB.spy, 0, 1e-12, "基准 TWR 继续可用");
  near(bVal.spy, 70, 1e-12, "不自动借款或做空");
  assert.ok(r.benchValueIssues.some(x=>/提款超过被动账户价值/.test(x)), r.benchValueIssues.join("; "));
});

test("the benchmark side and the portfolio side treat the flow the same way", () => {
  // 组合侧 (tot−f)/prev 让转入当天零收益；基准侧「先滚后加」也一样。
  const flat = periodReturns({
    points: [
      { d: "2026-08-01", tot: 100, spy: 100 },
      { d: "2026-08-02", tot: 1100, spy: 100 },   // 只有转入，行情没动
      { d: "2026-08-03", tot: 1210, spy: 110 },   // 基准 +10%，组合也 +10%
    ],
    openT: 100, from: "2026-08-01", to: "2026-08-03", days: 3, flowByDate: { "2026-08-02": 1000 },
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 100 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  near(flat.rG, 0.10, 1e-12, "组合 TWR");
  near(flat.rB.spy, 0.10, 1e-12, "基准");
});

test("a flow date without a same-day valuation disables returns instead of creating a false gain", () => {
  const broken = periodReturns({
    points: [
      { d: "2026-08-01", tot: 100, spy: 100 },
      { d: "2026-08-03", tot: 1100, spy: 100 },
    ],
    openT: 100, from: "2026-08-01", to: "2026-08-03", days: 3,
    flowByDate: { "2026-08-02": 1000 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 100 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  assert.equal(broken.rG, null);
  assert.equal(broken.rB.spy, null);
  assert.ok(broken.issues.some(x=>/出入金当日缺少估值 2026-08-02/.test(x)), broken.issues.join("; "));
});

test("a same-month flow outside the requested interval is refused", () => {
  const broken = periodReturns({
    points: [{ d: "2026-08-10", tot: 100 }],
    openT: 100, from: "2026-08-10", to: "2026-08-10", days: 1,
    flowByDate: { "2026-08-05": 50 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [], bPrev: {}, bVal: {}, bHas: {},
  });
  assert.equal(broken.rG, null);
  assert.equal(broken.flowT, 0);
  assert.ok(broken.issues.some(x=>/出入金日期越界 2026-08-05/.test(x)), broken.issues.join("; "));
});
