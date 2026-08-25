/**
 * 收益率口径 v4.6 的回归测试。
 *
 * 2026-08-25 自查发现三件事，这里逐条钉死：
 *   1. 口径 §9 写「时间加权」，实现的却是逐月 Modified Dietz。一笔占期初 55.8%
 *      的实物转入落在月内第 20 天时，两者差 0.12pp；换个时点可以差几个百分点。
 *   2. 出入金的在场天数差一天：转入按 8/20 收盘价计价，当天吃不到行情，只在场
 *      8/21–8/24 共 4 天，而代码按 5 天计权，系统性低估流入月的收益率。
 *   3. 基准按欧洲收盘取价，与组合的美股收盘估值错位 0.9pp，大于当期跑赢幅度。
 *
 * 用的是 2026-08 的真实数据（claude/每日AUM快照.md 的逐日总资产 + IBKR 的
 * SPY/QQQ 收盘价），所以任何一处口径漂移都会在这里炸出来。
 *
 * periodReturns 从 index.html 抽出来跑，页面仍保持单文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const START = "/* returns:start";
const END = "/* returns:end */";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from >= 0 && to > from, "index.html must carry the returns block");
assert.equal(html.indexOf(START, from + 1), -1, "the returns block must appear once");
const block = html.slice(from, to);
const periodReturns = new Function(`${block}\nreturn periodReturns;`)();

/* ---------------- 2026-08 实测数据 ---------------- */

const OPEN = 694814.16;          // 2026-07-31 起始基准
const TRANSFER = 387550.80;      // BRK/B 780 股自 IB-HK 实物转入，业务日 2026-08-20

// 逐日合计总资产（NY 市场日；周末沿用最近收盘）
const TOTALS = [
  ["2026-08-01", 694814.16], ["2026-08-02", 694814.16], ["2026-08-03", 729944.18],
  ["2026-08-04", 746886.19], ["2026-08-05", 734885.91], ["2026-08-06", 733687.82],
  ["2026-08-07", 740571.49], ["2026-08-08", 740571.49], ["2026-08-09", 740571.49],
  ["2026-08-10", 741553.95], ["2026-08-11", 733830.63], ["2026-08-12", 732583.52],
  ["2026-08-13", 734145.13], ["2026-08-14", 737333.42], ["2026-08-15", 737333.42],
  ["2026-08-16", 737333.42], ["2026-08-17", 733158.15], ["2026-08-18", 720236.60],
  ["2026-08-19", 717294.31], ["2026-08-20", 1102803.74], ["2026-08-21", 1105447.13],
  ["2026-08-22", 1105447.13], ["2026-08-23", 1105447.13], ["2026-08-24", 1114890.67],
];

// SPY / QQQ 收盘价（IBKR）。非交易日沿用最近收盘，与每日任务同规则。
const SPY_CLOSE = {
  "2026-07-31": 747.03, "2026-08-03": 757.67, "2026-08-04": 771.33, "2026-08-05": 769.79,
  "2026-08-06": 768.56, "2026-08-07": 773.26, "2026-08-10": 773.03, "2026-08-11": 770.56,
  "2026-08-12": 772.49, "2026-08-13": 777.88, "2026-08-14": 776.34, "2026-08-17": 772.67,
  "2026-08-18": 767.45, "2026-08-19": 769.06, "2026-08-20": 762.60, "2026-08-21": 765.72,
  "2026-08-24": 763.47,
};
const QQQ_CLOSE = {
  "2026-07-31": 687.99, "2026-08-03": 700.07, "2026-08-04": 723.85, "2026-08-05": 717.30,
  "2026-08-06": 714.65, "2026-08-07": 723.03, "2026-08-10": 720.87, "2026-08-11": 718.45,
  "2026-08-12": 723.70, "2026-08-13": 732.07, "2026-08-14": 731.07, "2026-08-17": 729.87,
  "2026-08-18": 717.51, "2026-08-19": 716.08, "2026-08-20": 710.93, "2026-08-21": 713.44,
  "2026-08-24": 706.32,
};
const carry = (table, d) => {
  const keys = Object.keys(table).sort().filter(k => k <= d);
  return table[keys[keys.length - 1]];
};

const BENCH = [{ k: "spy", dk: "spyd" }, { k: "qqq", dk: "qqqd" }];

const points = TOTALS.map(([d, tot]) => ({
  d, tot, spy: carry(SPY_CLOSE, d), qqq: carry(QQQ_CLOSE, d), spyd: 0, qqqd: 0,
}));

const august = (over = {}) => {
  const bPrev = { spy: SPY_CLOSE["2026-07-31"], qqq: QQQ_CLOSE["2026-07-31"] };
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

/* ---------------- 费用链条：与口径 §3 / §4 的闭式公式必须分文不差 ---------------- */

test("gross gain excludes the in-kind transfer, and the fee chain matches §3/§4", () => {
  const r = august();
  near(r.pnl, 32525.71, 0.01, "当月净收益（毛）");
  near(r.mgmt, (OPEN + 1114890.67) / 2 * 0.02 * 24 / 365, 0.01, "管理费 §3");
  near(r.mgmt, 1189.94, 0.01, "管理费");
  near(r.carry, 6505.14, 0.01, "Carry");
  near(r.fees, 7695.08, 0.02, "费用合计");
});

/* ---------------- 1. 逐日 TWR，而不是逐月 Modified Dietz ---------------- */

test("the gross rate is a daily time-weighted chain", () => {
  const r = august();
  near(r.rG, 0.040699, 0.00002, "投资收益率（逐日 TWR，扣费前）");
  // 旧的逐月 Modified Dietz 会给 4.19%；差 0.12pp 全部来自方法本身。
  assert.ok(Math.abs(r.rG - 0.041939) > 0.001, "rG must not fall back to monthly Modified Dietz");
});

test("the net rate is the same chain run on the after-fee NAV", () => {
  const r = august();
  near(r.rN, 0.030928, 0.00002, "扣费后（同口径 TWR）");
  // 同口径相减才是纯费用侵蚀。
  near(r.rG - r.rN, 0.009771, 0.00005, "费用侵蚀");
});

/* ---------------- 2. 出入金在场天数：4/24，不是 5/24 ---------------- */

test("a flow booked at its own close is out of the market that day", () => {
  const r = august();
  // 分母 = 694,814.16 + 387,550.80 × 4/24
  near(r.den, 759405.96, 0.01, "Modified Dietz 分母");
  assert.ok(Math.abs(r.den - (OPEN + TRANSFER * 5 / 24)) > 1,
    "the flow must not be credited with the day it was priced on");
});

test("the LP rate is Modified Dietz and converges on the true IRR", () => {
  const r = august();
  near(r.rD, 0.032697, 0.00002, "出资方净收益率");
  // 同一现金流序列的真实 IRR 是 3.2735%；两种 money-weighted 方法必须收敛。
  near(r.rD, 0.032735, 0.0001, "Modified Dietz vs IRR");
});

test("the LP rate carries the LP's own timing, so it is not a fee gap", () => {
  const r = august();
  // 出资方 8/20 加仓、8/24 涨 0.85%，择时给他多赚了约 0.21pp。
  assert.ok(r.rD > r.rN, "the LP rate must sit above the after-fee TWR this month");
  near((r.pnl / r.den) - r.rG, 0.00213, 0.0002, "出资方择时效应");
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
  near(r.rB.spy, 763.47 / 747.03 - 1, 0.00001, "S&P 500（SPY）");
  near(r.rB.qqq, 706.32 / 687.99 - 1, 0.00001, "纳斯达克100（QQQ）");
  near(r.rB.spy, 0.022007, 0.0001, "SPY 同期");
  near(r.rB.qqq, 0.026643, 0.0001, "QQQ 同期");
});

test("the August outperformance survives on a single valuation time", () => {
  const r = august();
  // 欧洲收盘口径下是 +1.10pp / +0.62pp，都小于 0.9pp 的时点错位，站不住。
  assert.ok(r.rG - r.rB.spy > 0.015, "vs S&P 500");
  assert.ok(r.rG - r.rB.qqq > 0.012, "vs NASDAQ-100");
});

test("a dividend on its ex-date lifts the chain by exactly that amount", () => {
  const withDiv = periodReturns({
    points: [
      { d: "2026-09-17", tot: 100, spy: 770.10, spyd: 0 },
      { d: "2026-09-18", tot: 100, spy: 768.40, spyd: 1.903516 },
    ],
    openT: 100, from: "2026-09-17", to: "2026-09-18", days: 2, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 770.10 }, bVal: { spy: 100 }, bHas: { spy: false },
  });
  // 除息日价格掉了 1.70，把 1.903516 加回去才是总回报。
  near(withDiv.rB.spy, (768.40 + 1.903516) / 770.10 - 1, 1e-12, "含息链");
  assert.ok(withDiv.rB.spy > 0, "the total-return chain must survive the price drop");
});

test("a missing benchmark price makes the benchmark unavailable, never guessed", () => {
  const gap = periodReturns({
    points: [
      { d: "2026-08-01", tot: 100, spy: 747.03 },
      { d: "2026-08-02", tot: 100, spy: 0 },
      { d: "2026-08-03", tot: 100, spy: 757.67 },
    ],
    openT: 100, from: "2026-08-01", to: "2026-08-03", days: 3, flowByDate: {},
    rate: 0, cr: 0, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    bench: [{ k: "spy", dk: "spyd" }],
    bPrev: { spy: 747.03 }, bVal: { spy: 100 }, bHas: { spy: false },
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

/* ---------------- 现值对照：两侧对 flow 的处理必须对称 ---------------- */

test("the what-if-I-had-bought-the-index figure rolls the flow from its own date", () => {
  const r = august();
  // 转入按 8/20 收盘入账，之后才跟着基准涨跌：
  //   694,814.16 × (763.47/747.03) + 387,550.80 × (763.47/762.60)
  const rolled = OPEN * (763.47 / 747.03) + TRANSFER * (763.47 / 762.60);
  const monthEnd = OPEN * (763.47 / 747.03) + TRANSFER;   // 旧写法：flow 整月不吃基准收益
  near(r.bVal.spy, rolled, 1.0, "同期全仓买入 S&P 500");
  assert.ok(Math.abs(rolled - monthEnd) > 300,
    "this month the two conventions must differ enough for the test to bite");
  assert.ok(Math.abs(r.bVal.spy - monthEnd) > 300,
    "the flow must not sit out the whole month on the benchmark side");
  near(r.bVal.qqq, OPEN * (706.32 / 687.99) + TRANSFER * (706.32 / 710.93), 1.0,
    "同期全仓买入 纳斯达克100");
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
