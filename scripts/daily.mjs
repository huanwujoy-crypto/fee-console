#!/usr/bin/env node
// 每日数据写入脚本（由 Cowork 定时任务调用）。无第三方依赖。
//
// 密钥只从环境变量 FEE_DATA_KEY 读取（32 字节 base64url）；命令行 --key 一律拒绝。
// 用法：
//   FEE_DATA_KEY=<base64url 32字节> node scripts/daily.mjs --date=2026-08-15 \
//     --schwab=617581.03 --webull=116529.69 [--cspx=... --eqqq=...] \
//     [--flows='[{"date":"2026-08-10","acct":"schwab","amount":25000,"desc":"Wire in"}]'] \
//     [--file=data.json]
//
// 行为：读取 data.json（AES-256-GCM v3）→ 校验 → 合并当日数据点与出入金候选 → 原子写回。
// 幂等：当日数据点完全相同且没有新的 flow id 时，打印 "no-op <date>" 并以 0 退出，
//       不改动 updatedAt / IV / 文件字节。
// 输出只含状态与计数，绝不打印金额或密钥。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(["date", "flows", "file"]);
const MOVE_WARN = 0.15; // >15% 无同日出入金时告警（不阻断）

const die = msg => { console.error("error: " + msg); process.exit(1); };

const isIsoDate = s => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
if (argv.some(a => a === "--key" || a.startsWith("--key=")))
  die("--key is refused; supply the 32-byte base64url key via the FEE_DATA_KEY environment variable");

const args = {};
for (const a of argv) {
  const m = /^--([^=]+)=([\s\S]*)$/.exec(a);
  if (!m) die(`bad argument ${JSON.stringify(a)} (expected --name=value)`);
  if (Object.prototype.hasOwnProperty.call(args, m[1])) die(`duplicate --${m[1]}`);
  args[m[1]] = m[2];
}

const date = args.date;
if (date === undefined) die("missing --date");
if (!isIsoDate(date)) die("--date must be a valid ISO calendar date (YYYY-MM-DD)");

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
let data = { updatedAt: "", daily: [], flowsAuto: [] };
if (fs.existsSync(file)) {
  let outer;
  try { outer = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { die(`${file} is not valid JSON`); }
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) die(`${file} has an unexpected shape`);
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
}
if (!data || typeof data !== "object" || Array.isArray(data)) die("decrypted payload has an unexpected shape");
data.daily = Array.isArray(data.daily) ? data.daily : [];
data.flowsAuto = Array.isArray(data.flowsAuto) ? data.flowsAuto : [];

/* ---------- 当日数据点 ---------- */
const point = { d: date };
for (const [k, v] of Object.entries(args)) {
  if (RESERVED.has(k)) continue;
  if (!FIELD_RE.test(k)) die(`invalid field name --${k}`);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())) die(`--${k} is not a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${k} must be a finite number`);
  if (!(n > 0)) die(`--${k} must be greater than 0`);
  point[k] = n;
}
const fields = Object.keys(point).filter(k => k !== "d");
if (!fields.length) die("no account/index values given");

/* ---------- 出入金 ---------- */
let incoming = [];
if (args.flows !== undefined) {
  let parsed;
  try { parsed = JSON.parse(args.flows); }
  catch { die("--flows is not valid JSON"); }
  if (!Array.isArray(parsed)) die("--flows must be a JSON array");
  incoming = parsed.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) die(`flow #${i} must be an object`);
    if (!isIsoDate(f.date)) die(`flow #${i} has a bad date`);
    const acct = typeof f.acct === "string" ? f.acct : "";
    if (!FIELD_RE.test(acct)) die(`flow #${i} has a bad acct`);
    const amount = typeof f.amount === "number" ? f.amount : Number(String(f.amount).trim());
    if (!Number.isFinite(amount) || amount === 0) die(`flow #${i} amount must be a non-zero finite number`);
    const desc = f.desc == null ? "" : String(f.desc);
    if (desc.length > 200) die(`flow #${i} desc is too long`);
    const id = f.id == null || f.id === ""
      ? crypto.createHash("sha1").update([f.date, acct, amount, desc].join("|")).digest("hex").slice(0, 12)
      : String(f.id);
    if (!ID_RE.test(id)) die(`flow #${i} has a bad id`);
    return { id, date: f.date, acct, amount, desc };
  });
}
const knownIds = new Set(data.flowsAuto.map(f => f && f.id));
const fresh = [];
for (const f of incoming) {
  if (knownIds.has(f.id)) continue;
  knownIds.add(f.id);
  fresh.push(f);
}

/* ---------- 幂等：完全相同则不落盘 ---------- */
const samePoint = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every(k => Object.is(a[k], b[k]));
};
const existing = data.daily.filter(x => x && x.d === date);
if (existing.length === 1 && samePoint(existing[0], point) && fresh.length === 0) {
  console.log(`no-op ${date}`);
  process.exit(0);
}

/* ---------- 异动告警（不阻断） ---------- */
const prior = data.daily
  .filter(x => x && typeof x.d === "string" && x.d < date)
  .sort((a, b) => a.d.localeCompare(b.d))
  .pop();
if (prior) {
  const flowAccts = new Set([...data.flowsAuto, ...fresh].filter(f => f && f.date === date).map(f => f.acct));
  for (const k of fields) {
    const p = prior[k];
    if (!Number.isFinite(p) || p <= 0) continue;
    const move = Math.abs(point[k] - p) / p;
    if (move > MOVE_WARN && !flowAccts.has(k))
      console.warn(`warn: ${k} moved ${(move * 100).toFixed(1)}% vs ${prior.d} with no same-day flow`);
  }
}

/* ---------- 合并并原子写回 ---------- */
data.daily = data.daily.filter(x => x && x.d !== date);
data.daily.push(point);
data.daily.sort((a, b) => String(a.d).localeCompare(String(b.d)));
for (const f of fresh) data.flowsAuto.push(f);
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
  try { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* ignore */ }
};
writeAtomic(file, JSON.stringify({ enc: true, v: 3, data: enc(JSON.stringify(data)) }));

console.log(`ok ${date} points=${data.daily.length} flows=${data.flowsAuto.length} new-flows=${fresh.length} fields=${fields.length}`);
