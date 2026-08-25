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

const BENCH_FIELDS = new Set(["spy", "qqq", "spyd", "qqqd"]);
const stripBench = point => Object.fromEntries(
  Object.entries(point).filter(([k]) => !BENCH_FIELDS.has(k)));

const SERIES = {
  spy: { "2026-07-31": 747.03, "2026-08-19": 769.06, "2026-08-24": 763.47 },
  qqq: { "2026-07-31": 687.99, "2026-08-19": 716.08, "2026-08-24": 706.32 },
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
  const r = run(dir, { spy: SERIES.spy, qqq: SERIES.qqq, spyd: { "2026-08-20": 1.9 } });
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
