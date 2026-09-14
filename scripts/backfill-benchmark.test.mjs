/**
 * backfill-benchmark.mjs 的隔离性测试。
 *
 * 这个脚本会碰真实的 data.json，所以唯一要证明的事情是：**它只写基准字段**。
 * 组合 AUM、拆分、flows、status、prov 标记、数据点的数量与日期，全部必须逐字节不变。
 *
 * 用明文 data.json 跑（脚本对 enc/明文两种输入都支持），这样测试不需要密钥。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "scripts", "backfill-benchmark.mjs");

// 结构照搬真实 data.json：两个账户、三项拆分、旧欧洲基准、prov 标记、flows、status。
const SEED = () => ({
  updatedAt: "2026-08-25T02:00:00.000Z",
  daily: [
    { d: "2026-07-31", schwab: 589712.03, webull: 105102.13, cash: 58520.03, stock: 636294.13,
      other: 0, cspx: 800.53, eqac: 480.35 },
    { d: "2026-08-19", schwab: 598267.86, webull: 119026.45, cash: 282513.00, stock: 434781.31,
      other: 0, cspx: 832.79, eqac: 505.10, prov: 1 },
    { d: "2026-08-24", schwab: 602638.37, webull: 512252.30, cash: 262634.47, stock: 852256.20,
      other: 0, cspx: 825.29, eqac: 497.50, prov: 1 },
  ],
  flowsAuto: [{
    id: "6f1c9a2b7d4e8503", date: "2026-08-20", acct: "webull", amount: 387550.80,
    desc: "verified external asset transfer BRK/B 780 from IB-HK",
    reason: "ib-hk-webull-brkb-20260820-780-v1", effective: true,
  }],
  flowsUnresolved: [{ id: "u1", date: "2026-08-18", acct: "schwab", amount: -4000 }],
  status: { asOf: "2026-08-24", provisional: true, notes: ["webull: valued on 2026-08-23"] },
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bf-"));
const run = (dir, series, extra = []) => {
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify(series));
  const writeArgs = extra.includes("--dry-run") ? [] : ["--backup=preimage.backup"];
  return spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
      "--baseline=2026-07-31", "--from=2026-07-31", "--to=2026-08-24", ...writeArgs, ...extra],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
};
const seedDir = () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(SEED()));
  return dir;
};
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));

const BENCH_FIELDS = new Set(["spy", "qqq", "spyd", "qqqd", "bd", "bstate"]);
const stripBench = point => Object.fromEntries(
  Object.entries(point).filter(([k]) => !BENCH_FIELDS.has(k)));

const SERIES = {
  spy: { "2026-07-31": 747.03, "2026-08-19": 769.06, "2026-08-24": 763.47 },
  qqq: { "2026-07-31": 687.99, "2026-08-19": 716.08, "2026-08-24": 706.32 },
  bd: { "2026-07-31": "2026-07-31", "2026-08-19": "2026-08-19", "2026-08-24": "2026-08-24" },
};

test("everything that is not a benchmark field survives byte-identical", () => {
  const dir = seedDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const before = SEED();
  const r = run(dir, SERIES);
  assert.equal(r.status, 0, r.stderr);
  const after = read(dir);

  // 数据点的数量与日期不变——脚本绝不新建或删除数据点。
  assert.equal(after.daily.length, before.daily.length);
  assert.deepEqual(after.daily.map(p => p.d), before.daily.map(p => p.d));

  // 每个点上除基准字段外的所有键，逐一深比。
  for (let i = 0; i < before.daily.length; i += 1) {
    assert.deepEqual(stripBench(after.daily[i]), stripBench(before.daily[i]),
      `daily[${i}] (${before.daily[i].d}) 的非基准字段被改动了`);
  }

  // 组合 AUM、拆分、prov、旧欧洲基准全部原样保留。
  assert.equal(after.daily[2].schwab, 602638.37);
  assert.equal(after.daily[2].webull, 512252.30);
  assert.equal(after.daily[2].cash, 262634.47);
  assert.equal(after.daily[2].prov, 1);
  assert.equal(after.daily[2].cspx, 825.29, "旧口径字段不得被清掉——历史回放要用");
  assert.equal(after.daily[2].eqac, 497.50);

  // flows / status —— Carry、高水位、管理费全都建立在这些之上。
  assert.deepEqual(after.flowsAuto, before.flowsAuto);
  assert.deepEqual(after.flowsUnresolved, before.flowsUnresolved);
  assert.deepEqual(after.status, before.status);

  // 顶层只允许多出 updatedAt 的变化。
  const topKeys = k => Object.keys(k).sort();
  assert.deepEqual(topKeys(after), topKeys(before));
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt 应该刷新");
  assert.equal(fs.readFileSync(path.join(dir, "preimage.backup"), "utf8"), raw,
    "backup 必须是写入前的逐字节副本");
});

test("the benchmark fields land exactly where the series says", () => {
  const dir = seedDir();
  run(dir, SERIES);
  const after = read(dir);
  assert.equal(after.daily[0].spy, 747.03);
  assert.equal(after.daily[0].qqq, 687.99);
  assert.equal(after.daily[2].spy, 763.47);
  assert.equal(after.daily[2].qqq, 706.32);
});

test("--dry-run changes nothing on disk", () => {
  const dir = seedDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, SERIES, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run: 3 point\(s\) would change/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw,
    "dry-run 之后 data.json 必须逐字节不变");
});

test("a date with no daily point fails closed and is never created", () => {
  const dir = seedDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, {
    spy: { ...SERIES.spy, "2026-08-20": 999 },
    qqq: { ...SERIES.qqq, "2026-08-20": 999 },
    bd: { ...SERIES.bd, "2026-08-20": "2026-08-20" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2026-08-20/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("rerunning is a no-op, so a repeated run cannot drift the file", () => {
  const dir = seedDir();
  run(dir, SERIES);
  const first = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, SERIES);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^no-op /m);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), first);
});

test("an unknown field is refused before anything is written", () => {
  const dir = seedDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, { schwab: { "2026-08-24": 1 } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown series field schwab/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("a dividend without its price is refused before anything is written", () => {
  const dir = seedDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, { spy: SERIES.spy, qqq: SERIES.qqq, bd: SERIES.bd, spyd: { "2026-08-20": 1.9 } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /paired benchmark price spy/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("an existing different benchmark value is never overwritten", () => {
  const dir = seedDir(), before = read(dir);
  before.daily[2].spy = 700;
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(before));
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = run(dir, SERIES);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite existing spy/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("actual writes require an explicit recoverable backup path", () => {
  const dir = seedDir();
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify(SERIES));
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-07-31", "--from=2026-07-31", "--to=2026-08-24"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /actual write requires --backup/);
});

test("tail repair adds mandatory benchmark-date evidence without touching portfolio data", () => {
  const dir = tmp();
  const before = {
    updatedAt: "2026-09-12T00:00:00.000Z",
    daily: [
      { d: "2026-09-10", schwab: 10, webull: 20, cash: 5, stock: 25, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-10" },
      { d: "2026-09-11", schwab: 11, webull: 21, cash: 6, stock: 26, other: 0, prov: 1 },
    ],
    flowsAuto: [], flowsUnresolved: [],
    status: { asOf: "2026-09-11", provisional: true, notes: [] },
  };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(before));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-11": 651 },
    qqq: { "2026-09-11": 581 },
    bd: { "2026-09-11": "2026-09-11" },
  }));
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-11", "--from=2026-09-11", "--to=2026-09-11", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.equal(r.status, 0, r.stderr);
  const after = read(dir);
  assert.equal(after.daily[1].spy, 651);
  assert.equal(after.daily[1].qqq, 581);
  assert.equal(after.daily[1].bd, "2026-09-11");
  assert.deepEqual(stripBench(after.daily[1]), stripBench(before.daily[1]));
  assert.deepEqual(after.flowsAuto, before.flowsAuto);
  assert.deepEqual(after.flowsUnresolved, before.flowsUnresolved);
  assert.deepEqual(after.status, before.status);
});

test("post-migration benchmark repair fails closed without bd", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    updatedAt: "2026-09-12T00:00:00.000Z",
    daily: [{ d: "2026-09-11", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 }],
    flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-09-11", provisional: true, notes: [] },
  }));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-11": 651 }, qqq: { "2026-09-11": 581 },
  }));
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-11", "--from=2026-09-11", "--to=2026-09-11", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing bd/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("pre-cutover backfill cannot create a state-less weekend benchmark point", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    updatedAt: "2026-09-06T00:00:00.000Z",
    daily: [
      { d: "2026-09-04", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-04", bstate: "session" },
      { d: "2026-09-05", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 },
    ],
    flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-09-05", provisional: true, notes: [] },
  }));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-05": 650 }, qqq: { "2026-09-05": 580 },
  }));
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-05", "--from=2026-09-05", "--to=2026-09-05", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2026-09-05: series is missing bd/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("same-date backfill derives and persists bstate=session", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    updatedAt: "2026-09-15T00:00:00.000Z",
    daily: [{ d: "2026-09-14", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 }],
    flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-09-14", provisional: false, notes: [] },
  }));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-14": 660 }, qqq: { "2026-09-14": 590 },
    bd: { "2026-09-14": "2026-09-14" },
  }));
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-14", "--from=2026-09-14", "--to=2026-09-14", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir).daily[0].bstate, "session");
});

test("lagged backfill requires explicit bstate=closed after cutover", () => {
  const base = {
    updatedAt: "2026-09-16T00:00:00.000Z",
    daily: [
      { d: "2026-09-14", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 660, qqq: 590, bd: "2026-09-14", bstate: "session" },
      { d: "2026-09-15", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 },
    ], flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-09-15", provisional: true, notes: [] },
  };
  const make = bstate => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(base));
    const series = {
      spy: { "2026-09-15": 660 }, qqq: { "2026-09-15": 590 },
      bd: { "2026-09-15": "2026-09-14" },
    };
    if (bstate !== undefined) series.bstate = { "2026-09-15": bstate };
    fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify(series));
    return dir;
  };
  const refused = make();
  const raw = fs.readFileSync(path.join(refused, "data.json"), "utf8");
  const bad = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-15", "--from=2026-09-15", "--to=2026-09-15", "--backup=preimage.backup"],
    { cwd: refused, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /explicit bstate=closed/);
  assert.equal(fs.readFileSync(path.join(refused, "data.json"), "utf8"), raw);

  const accepted = make("closed");
  const good = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-15", "--from=2026-09-15", "--to=2026-09-15", "--backup=preimage.backup"],
    { cwd: accepted, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(read(accepted).daily[1].bstate, "closed");
});

test("backfill validates bstate values and same-date consistency", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    updatedAt: "2026-09-15T00:00:00.000Z",
    daily: [{ d: "2026-09-14", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 }],
    flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-09-14", provisional: false, notes: [] },
  }));
  const invoke = state => {
    fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
      spy: { "2026-09-14": 660 }, qqq: { "2026-09-14": 590 },
      bd: { "2026-09-14": "2026-09-14" }, bstate: { "2026-09-14": state },
    }));
    return spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
      "--baseline=2026-09-14", "--from=2026-09-14", "--to=2026-09-14", "--backup=preimage.backup"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  };
  assert.match(invoke("unknown").stderr, /must be one of session or closed/);
  assert.match(invoke("closed").stderr, /same-date benchmark evidence must use bstate=session/);
});

test("backfill cannot use the read-only legacy exception to create a state-less carry", () => {
  const invoke = (d, bd) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
      updatedAt: "2026-09-13T00:00:00.000Z",
      daily: [
        { d: bd, schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
          spy: 650, qqq: 580, bd, bstate: "session" },
        { d, schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 },
      ],
      flowsAuto: [], flowsUnresolved: [], status: { asOf: d, provisional: true, notes: [] },
    }));
    fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
      spy: { [d]: 650 }, qqq: { [d]: 580 }, bd: { [d]: bd },
    }));
    const result = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
      `--baseline=${d}`, `--from=${d}`, `--to=${d}`, "--backup=preimage.backup"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
    return { dir, result };
  };
  const weekday = invoke("2026-09-11", "2026-09-10");
  assert.notEqual(weekday.result.status, 0);
  assert.match(weekday.result.stderr, /explicit bstate=closed/);

  const weekend = invoke("2026-09-12", "2026-09-11");
  assert.notEqual(weekend.result.status, 0);
  assert.match(weekend.result.stderr, /explicit bstate=closed/);
});

test("whole-ledger validation refuses an interior benchmark gap outside the requested slice", () => {
  const dir = tmp();
  const data = {
    updatedAt: "2026-09-13T00:00:00.000Z",
    daily: [
      { d: "2026-09-10", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-10" },
      { d: "2026-09-11", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 },
      { d: "2026-09-12", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-10" },
    ], flowsAuto: [], flowsUnresolved: [],
    status: { asOf: "2026-09-12", provisional: true, notes: [] },
  };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-10": 650 }, qqq: { "2026-09-10": 580 },
    bd: { "2026-09-10": "2026-09-10" },
  }));
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-10", "--from=2026-09-10", "--to=2026-09-10", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2026-09-12: persisted closed evidence is not anchored to the prior proven session/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("whole-ledger validation rejects a bd regression introduced by repair", () => {
  const dir = tmp();
  const data = {
    updatedAt: "2026-09-13T00:00:00.000Z",
    daily: [
      { d: "2026-09-10", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-10" },
      { d: "2026-09-11", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0 },
      { d: "2026-09-12", schwab: 1, webull: 1, cash: 1, stock: 1, other: 0,
        spy: 650, qqq: 580, bd: "2026-09-10" },
    ], flowsAuto: [], flowsUnresolved: [],
    status: { asOf: "2026-09-12", provisional: true, notes: [] },
  };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify({
    spy: { "2026-09-11": 651 }, qqq: { "2026-09-11": 581 },
    bd: { "2026-09-11": "2026-09-11" },
  }));
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-11", "--from=2026-09-11", "--to=2026-09-11", "--backup=preimage.backup"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /benchmark timeline invalid: .*regresses/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

/* ---------- --resolve-carry：把工作日的 carry 换成同日证据 ---------- */
// 真实形态（2026-09-11）：工作日当时没等到自己的收盘价，先沿用上一交易日的
// bundle；行情到齐后只挂在了周末点上，那个工作日仍是未证明的缺口。
const CARRY_SEED = () => ({
  updatedAt: "2026-09-13T00:00:00.000Z",
  daily: [
    { d: "2026-09-10", schwab: 10, webull: 20, cash: 5, stock: 25, other: 0,
      spy: 650, qqq: 580, bd: "2026-09-10" },
    { d: "2026-09-11", schwab: 11, webull: 21, cash: 6, stock: 26, other: 0,
      spy: 650, qqq: 580, bd: "2026-09-10", prov: 1, sourceFingerprint: "a".repeat(64) },
    { d: "2026-09-12", schwab: 12, webull: 22, cash: 7, stock: 27, other: 0,
      spy: 651, qqq: 581, bd: "2026-09-11", prov: 1 },
    { d: "2026-09-13", schwab: 13, webull: 23, cash: 8, stock: 28, other: 0,
      spy: 651, qqq: 581, bd: "2026-09-11", prov: 1 },
  ],
  flowsAuto: [], flowsUnresolved: [],
  status: { asOf: "2026-09-13", provisional: true, notes: ["benchmark priced on 2026-09-11"] },
});
const SAME_DAY_SERIES = {
  spy: { "2026-09-11": 651 }, qqq: { "2026-09-11": 581 },
  bd: { "2026-09-11": "2026-09-11" },
};
const carryDir = (data = CARRY_SEED(), series = SAME_DAY_SERIES) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "series.json"), JSON.stringify(series));
  return dir;
};
const runCarry = (dir, extra = []) => spawnSync(process.execPath,
  [SCRIPT, "--file=data.json", "--series=series.json", "--baseline=2026-09-11",
    "--from=2026-09-11", "--to=2026-09-11", "--backup=preimage.backup", ...extra],
  { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });

test("resolve-carry replaces a carried workday bundle with same-day evidence only", () => {
  const dir = carryDir(), before = CARRY_SEED();
  const r = runCarry(dir, ["--resolve-carry"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /resolve 2026-09-11 \[spy qqq bd bstate\] carried-from=2026-09-10/);
  assert.match(r.stdout, /points-resolved=1/);
  const after = read(dir);
  assert.equal(after.daily[1].spy, 651);
  assert.equal(after.daily[1].qqq, 581);
  assert.equal(after.daily[1].bd, "2026-09-11");
  assert.equal(after.daily[1].bstate, "session");
  // 组合数据、prov、来源凭证与其它每一天都必须逐字节不变。
  for (let i = 0; i < before.daily.length; i += 1) {
    assert.deepEqual(stripBench(after.daily[i]), stripBench(before.daily[i]));
    if (i !== 1) assert.deepEqual(after.daily[i], before.daily[i]);
  }
  assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.flowsAuto, before.flowsAuto);
  assert.equal(fs.readFileSync(path.join(dir, "preimage.backup"), "utf8"),
    JSON.stringify(CARRY_SEED()));
});

test("resolving a carried bundle stays opt-in", () => {
  const dir = carryDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = runCarry(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite existing spy/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("resolve-carry refuses a point that already proves its own session", () => {
  const data = CARRY_SEED();
  data.daily[1].spy = 649; data.daily[1].qqq = 579; data.daily[1].bd = "2026-09-11";
  data.daily[2].spy = 649; data.daily[2].qqq = 579;
  data.daily[3].spy = 649; data.daily[3].qqq = 579;
  const dir = carryDir(data);
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = runCarry(dir, ["--resolve-carry"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite existing spy/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("resolve-carry refuses a bundle that is not a carry of its own bd", () => {
  const data = CARRY_SEED();
  data.daily[1].spy = 649;   // 独立读数，不是 2026-09-10 的 carry
  const dir = carryDir(data);
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = runCarry(dir, ["--resolve-carry"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2026-09-11: persisted benchmark bundle is not a proven carry of 2026-09-10/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("resolve-carry refuses to contradict a price already published for that bd", () => {
  const data = CARRY_SEED();
  data.daily[2].spy = 652; data.daily[2].qqq = 582;
  data.daily[3].spy = 652; data.daily[3].qqq = 582;
  const dir = carryDir(data);
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = runCarry(dir, ["--resolve-carry"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /repeated bd 2026-09-11 changed a persisted benchmark price/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("resolve-carry refuses a carried bundle that already records a dividend", () => {
  const data = CARRY_SEED();
  data.daily[1].spyd = 1.9;
  const dir = carryDir(data);
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = runCarry(dir, ["--resolve-carry"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to resolve a carried bundle that already records a dividend/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});

test("resolve-carry leaves an untouched ledger byte-identical on a dry run", () => {
  const dir = carryDir();
  const raw = fs.readFileSync(path.join(dir, "data.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--file=data.json", "--series=series.json",
    "--baseline=2026-09-11", "--from=2026-09-11", "--to=2026-09-11", "--resolve-carry", "--dry-run"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: "A".repeat(43) + "=" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run: 1 point\(s\) would change/);
  assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), raw);
});
