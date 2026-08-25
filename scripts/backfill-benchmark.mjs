#!/usr/bin/env node
// 一次性基准回补（口径 v4.6 迁移用）。
//
// 为什么需要单独一个脚本：daily.mjs 的 buildPoint() 会重建整个数据点，且
// MAX_LOOKBACK_DAYS = 10 天，够不到 2026-07-31 的起算基准；而换标的之后
// 8/1 起的历史行里没有 spy / qqq，基准线会整条消失。本脚本只往**已存在**的
// 数据点上补基准字段，绝不新建或删除数据点，也绝不碰 accounts / splits /
// flows / status。
//
// 密钥只从环境变量 FEE_DATA_KEY 读取（32 字节 base64url），与 daily.mjs 一致。
//
//   node scripts/backfill-benchmark.mjs --series=backfill.json --baseline=2026-07-31
//     --from=2026-07-31 --to=2026-08-31 [--file=data.json] [--dry-run]
//   实际写入还必须给 --backup=<preimage path>；dry-run 不需要。
//
// series 文件形如：
//   { "spy":  { "2026-07-31": 747.03, "2026-08-01": 747.03 },
//     "qqq":  { "2026-07-31": 687.99, "2026-08-01": 687.99 },
//     "spyd": { "2026-09-18": 1.9 } }
// 非交易日沿用最近收盘价（与每日任务同规则），所以周末也要给值。
//
// 输出只含日期与字段名，绝不打印价格或密钥。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BENCH_KEYS, BENCH_DIV_KEYS, isIsoDate } from "./daily-core.mjs";

const die = msg => { console.error("error: " + msg); process.exit(1); };

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
if (argv.some(a => a === "--key" || a.startsWith("--key=")))
  die("--key is refused; supply the 32-byte base64url key via the FEE_DATA_KEY environment variable");

const args = {};
const flags = new Set();
for (const a of argv) {
  const m = /^--([^=]+)=([\s\S]*)$/.exec(a);
  if (!m) {
    const f = /^--([a-z][a-z0-9-]*)$/.exec(a);
    if (!f) die(`bad argument ${JSON.stringify(a)} (expected --name=value)`);
    flags.add(f[1]);
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(args, m[1])) die(`duplicate --${m[1]}`);
  args[m[1]] = m[2];
}
for (const k of Object.keys(args)) if (!["series", "file", "baseline", "from", "to", "backup"].includes(k)) die(`unknown argument --${k}`);
for (const f of flags) if (f !== "dry-run") die(`unknown flag --${f}`);
const dryRun = flags.has("dry-run");
if (!args.series) die("missing --series=<path to the backfill JSON>");
for (const k of ["baseline", "from", "to"]) if (!isIsoDate(args[k])) die(`--${k} must be a valid ISO date`);
if (args.from > args.to) die("--from must not be later than --to");
if (args.baseline < args.from || args.baseline > args.to) die("--baseline must be inside --from..--to");

/* ---------- series ---------- */
let series;
try { series = JSON.parse(fs.readFileSync(args.series, "utf8")); }
catch { die(`could not read ${args.series} as JSON`); }
if (!series || typeof series !== "object" || Array.isArray(series)) die("--series must be a JSON object");

const ALLOWED = new Set([...BENCH_KEYS, ...BENCH_DIV_KEYS]);
const updates = new Map();   // date -> { field: value }
for (const [field, byDate] of Object.entries(series)) {
  if (!ALLOWED.has(field)) die(`unknown series field ${field} (expected one of ${[...ALLOWED].join(", ")})`);
  if (!byDate || typeof byDate !== "object" || Array.isArray(byDate)) die(`series.${field} must be an object keyed by date`);
  const isDiv = BENCH_DIV_KEYS.includes(field);
  for (const [d, raw] of Object.entries(byDate)) {
    if (!isIsoDate(d)) die(`series.${field} has a bad date ${JSON.stringify(d)}`);
    const v = Number(raw);
    if (!Number.isFinite(v)) die(`series.${field}.${d} is not a finite number`);
    if (isDiv ? v < 0 : !(v > 0)) die(`series.${field}.${d} is out of range`);
    if (!updates.has(d)) updates.set(d, {});
    updates.get(d)[field] = v;
  }
}
for (const field of BENCH_KEYS) if (!series[field]) die(`series must contain ${field}`);
// 股息必须与同日价格成对，否则含息链会拿不到分母。
for (const [d, fields] of updates) {
  for (const k of BENCH_KEYS) if (fields[k] === undefined) die(`${d}: paired benchmark price ${k} is required`);
  for (const k of BENCH_DIV_KEYS) {
    if (fields[k] === undefined) continue;
    const priceKey = k.slice(0, -1);
    if (fields[priceKey] === undefined) die(`${d}: ${k} needs its price ${priceKey} in the same series file`);
  }
}
if (!updates.size) die("--series contains no values");
if (!updates.has(args.baseline)) die(`series is missing the required baseline ${args.baseline}`);
for (const d of updates.keys()) if (d < args.from || d > args.to) die(`${d}: series date is outside --from..--to`);

/* ---------- 密钥（仅环境变量） ---------- */
const rawKey = (process.env.FEE_DATA_KEY || "").trim();
if (!rawKey) die("FEE_DATA_KEY is not set (32-byte base64url key required)");
if (!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(rawKey)) die("FEE_DATA_KEY must be a 32-byte base64url value");
const key = Buffer.from(rawKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
if (key.length !== 32) die("FEE_DATA_KEY must decode to exactly 32 bytes");

const enc = txt => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(txt, "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
};
const dec = b64 => {
  const b = Buffer.from(b64, "base64");
  if (b.length < 29) throw new Error("ciphertext too short");
  const iv = b.subarray(0, 12), ct = b.subarray(12, b.length - 16), tag = b.subarray(b.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
};

/* ---------- 读取 ---------- */
const file = args.file || "data.json";
if (!fs.existsSync(file)) die(`${file} does not exist; nothing to backfill`);
let outer,rawFile;
try { rawFile = fs.readFileSync(file, "utf8"); outer = JSON.parse(rawFile); }
catch { die(`${file} is not valid JSON`); }
if (!outer || typeof outer !== "object" || Array.isArray(outer)) die(`${file} has an unexpected shape`);

let data;
if (outer.enc) {
  if (outer.v !== 3) die(`unsupported encrypted format v${outer.v} (expected v3)`);
  if (typeof outer.data !== "string") die(`${file} is missing its ciphertext`);
  let plain;
  try { plain = dec(outer.data); }
  catch { die("decrypt failed (wrong FEE_DATA_KEY or corrupt data) — nothing written"); }
  try { data = JSON.parse(plain); }
  catch { die("decrypted payload is not valid JSON — nothing written"); }
} else {
  data = outer;
}
if (!data || typeof data !== "object" || Array.isArray(data)) die("decrypted payload has an unexpected shape");
if (!Array.isArray(data.daily) || !data.daily.length) die("no daily points to backfill");

/* ---------- 只补基准字段 ---------- */
const byDate = new Map();
for (const p of data.daily) if (p && typeof p.d === "string") byDate.set(p.d, p);

const targetDates = [...byDate.keys()].filter(d => d >= args.from && d <= args.to).sort();
if (!targetDates.length) die(`no daily points in ${args.from}..${args.to}`);
if (!byDate.has(args.baseline)) die(`data has no baseline daily point ${args.baseline}`);
for (const d of targetDates) {
  const fields = updates.get(d);
  if (!fields) die(`${d}: series is missing a daily point`);
  for (const k of BENCH_KEYS) if (!(Number(fields[k]) > 0)) die(`${d}: series is missing ${k}`);
}
for (const d of updates.keys()) if (!byDate.has(d)) die(`${d}: data has no matching daily point`);

const touched = [], unchanged = [];
for (const [d, fields] of [...updates].sort((a, b) => a[0].localeCompare(b[0]))) {
  const point = byDate.get(d);
  const changed = [];
  for (const [k, v] of Object.entries(fields)) {
    if (BENCH_DIV_KEYS.includes(k) && v === 0) {
      // 0 不落字段。绝不因一次无事件的输入擦除已核实的历史股息。
      continue;
    }
    if (Object.is(point[k], v)) continue;
    if (point[k] !== undefined) die(`${d}: refusing to overwrite existing ${k}`);
    point[k] = v;
    changed.push(k);
  }
  if (changed.length) touched.push(`${d} [${changed.join(" ")}]`);
  else unchanged.push(d);
}

if (!touched.length) {
  console.log(`no-op ${file} (${unchanged.length} date(s) already carried these fields)`);
  process.exit(0);
}
for (const line of touched) console.log(`set ${line}`);
if (dryRun) {
  console.log(`dry-run: ${touched.length} point(s) would change; ${file} untouched`);
  process.exit(0);
}

if (!args.backup) die("actual write requires --backup=<preimage path>");
if (fs.existsSync(args.backup)) die(`${args.backup} already exists; choose a new backup path`);
const preimageHash = crypto.createHash("sha256").update(rawFile).digest("hex");
const backupFd = fs.openSync(args.backup, "wx", 0o600);
try { fs.writeFileSync(backupFd, rawFile); fs.fsyncSync(backupFd); }
finally { fs.closeSync(backupFd); }

data.updatedAt = new Date().toISOString();

const writeAtomic = (target, contents) => {
  const abs = path.resolve(target);
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.tmp`);
  let mode = 0o600;
  try { mode = fs.statSync(abs).mode & 0o777; } catch { /* new file */ }
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, abs); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
  try { const h = fs.openSync(dir, "r"); try { fs.fsyncSync(h); } finally { fs.closeSync(h); } } catch { /* ignore */ }
};
const nextFile = outer.enc
  ? JSON.stringify({ enc: true, v: 3, data: enc(JSON.stringify(data)) })
  : JSON.stringify(data);
writeAtomic(file, nextFile);
const postimageHash = crypto.createHash("sha256").update(nextFile).digest("hex");

console.log(`ok ${file} points-touched=${touched.length} points-unchanged=${unchanged.length} points-total=${data.daily.length} preimage-sha256=${preimageHash} postimage-sha256=${postimageHash} backup=${args.backup}`);
