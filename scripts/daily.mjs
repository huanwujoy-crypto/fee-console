#!/usr/bin/env node
// 每日数据写入脚本（由 Cowork 定时任务调用）。无第三方依赖。
//
// 密钥只从环境变量 FEE_DATA_KEY 读取（32 字节 base64url）；命令行 --key 一律拒绝。
//
// 定位：长期观察管理人能力。每日看趋势、周末自动校准、历史月份自动归档。
//   * 工作日允许一家券商比另一家晚一天同步 —— 照常写入，标 prov（暂估）。
//   * 周末两家都落定后，例行任务用同一估值日回看重写最近几天，加 --calibrated
//     清掉暂估标记。长期业绩与 SPY / QQQ 对比优先采用这些校准快照。
//   * 月份结束后自动成为历史月份，没有结算按钮，也不需要任何确认动作。
//
// 只阻断明显错账：重复/陈旧现金、内部交易被当成外部资金流、账户缺失、金额不可能。
//
// 幂等：数据点、flow 与 status 均无变化时打印 "no-op <date>" 并以 0 退出。
// 输出只含状态与计数，绝不打印金额或密钥。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ACCOUNTS, SPLITS, STYLE_SPLITS, STYLE_SPLIT_EPS, BENCH_KEYS, BENCH_DIV_KEYS, BENCH_LEGACY_KEYS,
  validateInputs, checkCashLedger, checkMove, reconcileFlows,
  buildPoint, samePoint, buildStatus, sameStatus, isIsoDate
} from "./daily-core.mjs";
import {
  buildFeeCalculationReceipt,
  normalizeEconomicInputs,
  sameFeeCalculationReceipt,
  validateFeeCalculationReceipt
} from "./fee-receipt-core.mjs";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SOURCE_FINGERPRINT_RE = /^[a-f0-9]{64}$/i;
const SOURCE_META_KEYS = new Set(["sourceFetchedAt", "sourceFingerprint"]);
const MAX_ECON_SNAPSHOT_BYTES = 5 * 1024 * 1024;

const die = msg => { console.error("error: " + msg); process.exit(1); };
const dieAll = msgs => { for (const m of msgs) console.error("error: " + m); process.exit(1); };

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
    if (flags.has(f[1])) die(`duplicate --${f[1]}`);
    flags.add(f[1]);
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(args, m[1])) die(`duplicate --${m[1]}`);
  args[m[1]] = m[2];
}

const num = (name, raw) => {
  if (!NUM_RE.test(String(raw).trim())) die(`--${name} is not a number`);
  const n = Number(raw);
  if (!Number.isFinite(n)) die(`--${name} must be a finite number`);
  return n;
};

const known = new Set([
  "date", "flows", "file", "src-bench", "source-fetched-at", "source-fingerprint",
  ...ACCOUNTS, ...SPLITS, ...STYLE_SPLITS, ...BENCH_KEYS, ...BENCH_DIV_KEYS, ...BENCH_LEGACY_KEYS,
  ...ACCOUNTS.map(a => `src-${a}`),
  ...ACCOUNTS.map(a => `acct-cash-${a}`),
  ...ACCOUNTS.map(a => `prev-acct-cash-${a}`)
]);
for (const k of Object.keys(args)) if (!known.has(k)) die(`unknown argument --${k}`);
for (const f of flags) if (f !== "calibrated") die(`unknown flag --${f}`);
const calibrated = flags.has("calibrated");

/* Optional source provenance.  Older callers may omit both fields. */
let sourceFetchedAt = null;
if (args["source-fetched-at"] !== undefined) {
  const raw = String(args["source-fetched-at"]).trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) {
    die("--source-fetched-at must be an RFC 3339 instant with a Z or numeric offset");
  }
  sourceFetchedAt = new Date(raw).toISOString();
}
let suppliedSourceFingerprint = null;
if (args["source-fingerprint"] !== undefined) {
  const raw = String(args["source-fingerprint"]).trim();
  if (!SOURCE_FINGERPRINT_RE.test(raw)) die("--source-fingerprint must be a 64-character SHA-256 hex value");
  if (!sourceFetchedAt) die("--source-fingerprint requires --source-fetched-at");
  suppliedSourceFingerprint = raw.toLowerCase();
}

const accounts = {}, splits = {}, styleSplits = {}, bench = {}, benchDiv = {}, sourceDates = {}, acctCash = {}, prevAcctCash = {};
for (const a of ACCOUNTS) {
  if (args[a] !== undefined) accounts[a] = num(a, args[a]);
  if (args[`src-${a}`] !== undefined) sourceDates[a] = args[`src-${a}`];
  if (args[`acct-cash-${a}`] !== undefined) acctCash[a] = num(`acct-cash-${a}`, args[`acct-cash-${a}`]);
  if (args[`prev-acct-cash-${a}`] !== undefined) prevAcctCash[a] = num(`prev-acct-cash-${a}`, args[`prev-acct-cash-${a}`]);
}
for (const s of SPLITS) if (args[s] !== undefined) splits[s] = num(s, args[s]);
for (const s of STYLE_SPLITS) if (args[s] !== undefined) styleSplits[s] = num(s, args[s]);
for (const b of BENCH_KEYS) if (args[b] !== undefined) bench[b] = num(b, args[b]);
for (const b of BENCH_LEGACY_KEYS) if (args[b] !== undefined) bench[b] = num(b, args[b]);
for (const b of BENCH_DIV_KEYS) if (args[b] !== undefined) benchDiv[b] = num(b, args[b]);

const date = args.date;
if (date === undefined) die("missing --date");

const check = validateInputs({
  date, accounts, splits, styleSplits, sourceDates, bench, benchDiv,
  benchDate: args["src-bench"] ?? null, calibrated, now: new Date()
});
if (check.errors.length) dieAll([...check.errors, "nothing written"]);

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

/* ---------- 私密经济输入（只接受仓库外的加密 v4 快照） ---------- */
const loadEconomicInput = () => {
  const configured = String(process.env.FEE_ECON_FILE || "").trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) die("FEE_ECON_FILE must be an absolute path");
  let target;
  try { target = fs.realpathSync(configured); }
  catch { die("FEE_ECON_FILE cannot be read — nothing written"); }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(repoRoot, target);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..")) {
    die("FEE_ECON_FILE must remain outside the repository — nothing written");
  }
  let first, second;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) die("FEE_ECON_FILE must be a regular file — nothing written");
    if (stat.size <= 0 || stat.size > MAX_ECON_SNAPSHOT_BYTES) {
      die("FEE_ECON_FILE has an invalid size — nothing written");
    }
    first = fs.readFileSync(target);
    second = fs.readFileSync(target);
  } catch {
    die("FEE_ECON_FILE cannot be read — nothing written");
  }
  if (!first.equals(second)) die("FEE_ECON_FILE changed while it was being read — nothing written");
  let outer;
  try { outer = JSON.parse(first.toString("utf8")); }
  catch { die("FEE_ECON_FILE is not valid JSON — nothing written"); }
  if (!outer || typeof outer !== "object" || Array.isArray(outer)
      || outer.enc !== true || outer.v !== 4 || typeof outer.data !== "string") {
    die("FEE_ECON_FILE must be an encrypted v4 envelope — nothing written");
  }
  let plain;
  try { plain = dec(outer.data); }
  catch { die("FEE_ECON_FILE decrypt failed (wrong key or corrupt data) — nothing written"); }
  let economicInput;
  try { economicInput = JSON.parse(plain); }
  catch { die("FEE_ECON_FILE decrypted payload is not valid JSON — nothing written"); }
  if (!economicInput || typeof economicInput !== "object" || Array.isArray(economicInput)
      || economicInput.v !== 4) {
    die("FEE_ECON_FILE decrypted payload must be fee-console v4 — nothing written");
  }
  return economicInput;
};

/* ---------- 读取 ---------- */
const file = args.file || "data.json";
let data = { updatedAt: "", daily: [], flowsAuto: [], flowsUnresolved: [] };
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
for (const field of ["daily", "flowsAuto", "flowsUnresolved"]) {
  if (Object.hasOwn(data, field) && !Array.isArray(data[field])) {
    die(`decrypted payload ${field} must be an array — nothing written`);
  }
  if (!Object.hasOwn(data, field)) data[field] = [];
  for (const [index, record] of data[field].entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      die(`decrypted payload ${field}[${index}] must be an object — nothing written`);
    }
  }
}
if (Object.hasOwn(data, "status")) {
  if (!data.status || typeof data.status !== "object" || Array.isArray(data.status)) {
    die("decrypted payload status must be an object — nothing written");
  }
  for (const field of ["asOf", "provisional", "calibrated", "splitDelta", "unresolvedCount", "notes"]) {
    if (!Object.hasOwn(data.status, field)) {
      die(`decrypted payload status.${field} is missing — nothing written`);
    }
  }
  if (!isIsoDate(data.status.asOf)) {
    die("decrypted payload status.asOf must be a calendar date — nothing written");
  }
  for (const field of ["provisional", "calibrated"]) {
    if (typeof data.status[field] !== "boolean") {
      die(`decrypted payload status.${field} must be a boolean — nothing written`);
    }
  }
  if (!Number.isFinite(data.status.splitDelta)) {
    die("decrypted payload status.splitDelta must be a finite number — nothing written");
  }
  if (!Number.isInteger(data.status.unresolvedCount) || data.status.unresolvedCount < 0) {
    die("decrypted payload status.unresolvedCount must be a non-negative integer — nothing written");
  }
  if (!Array.isArray(data.status.notes) || data.status.notes.some(note => typeof note !== "string")) {
    die("decrypted payload status.notes must be an array of strings — nothing written");
  }
}
const economicInput = loadEconomicInput();
if (economicInput) {
  try { normalizeEconomicInputs(economicInput); }
  catch (error) { die(`FEE_ECON_FILE economic input rejected: ${error.message} — nothing written`); }
}

/* ---------- 出入金输入 ---------- */
let incoming = [];
if (args.flows !== undefined) {
  let parsed;
  try { parsed = JSON.parse(args.flows); }
  catch { die("--flows is not valid JSON"); }
  if (!Array.isArray(parsed)) die("--flows must be a JSON array");
  incoming = parsed.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) die(`flow #${i} must be an object`);
    if (!isIsoDate(f.date)) die(`flow #${i} has a bad date`);
    if (!ACCOUNTS.includes(f.acct)) die(`flow #${i} has an unknown acct (expected one of ${ACCOUNTS.join(", ")})`);
    const amount = typeof f.amount === "number" ? f.amount : Number(String(f.amount).trim());
    if (!Number.isFinite(amount) || amount === 0) die(`flow #${i} amount must be a non-zero finite number`);
    const desc = f.desc == null ? "" : String(f.desc);
    if (desc.length > 300) die(`flow #${i} desc is too long`);
    if (f.id != null && f.id !== "" && !ID_RE.test(String(f.id))) die(`flow #${i} has a bad id`);
    if (f.evidence != null && !["external_transfer", "external_asset_transfer", "internal_trade"].includes(f.evidence))
      die(`flow #${i} has an unknown evidence value`);
    return {
      id: f.id == null || f.id === "" ? "" : String(f.id),
      date: f.date, acct: f.acct, amount, desc,
      type: f.type == null ? "" : String(f.type),
      sourceTradeId: f.sourceTradeId ?? null,
      tradeId: f.tradeId ?? null,
      holdingId: f.holdingId ?? null,
      sourceDate: f.sourceDate == null ? "" : String(f.sourceDate),
      destinationDate: f.destinationDate == null ? "" : String(f.destinationDate),
      sourceInstrument: f.sourceInstrument == null ? "" : String(f.sourceInstrument),
      destinationInstrument: f.destinationInstrument == null ? "" : String(f.destinationInstrument),
      sourceQuantity: Number.isFinite(f.sourceQuantity) ? f.sourceQuantity : 0,
      destinationQuantity: Number.isFinite(f.destinationQuantity) ? f.destinationQuantity : 0,
      foreignIdentifier: f.foreignIdentifier == null ? "" : String(f.foreignIdentifier),
      holdingDelta: Number.isFinite(f.holdingDelta) ? f.holdingDelta : 0,
      evidence: f.evidence ?? null,
      externalRef: f.externalRef == null ? "" : String(f.externalRef)
    };
  });
}

/* ---------- 明显错账检查 ---------- */
const hard = [];
hard.push(...checkCashLedger({ date, acctCash, prevAcctCash, movements: incoming }));

const flows = reconcileFlows(data.flowsAuto, data.flowsUnresolved, incoming);
hard.push(...flows.errors);

const point = buildPoint({ date, accounts, splits, styleSplits, bench, benchDiv, provisional: check.provisional, calibrated });
const existingPoint = data.daily.find(x => x && x.d === date);
// A read-only correction that leaves `stock` unchanged must not erase a style
// look-through already verified for the same day.  If stock changes materially,
// the old style pair is deliberately dropped so the UI falls back to
// “股票（未拆分）” instead of presenting stale classification.
const noIncomingStyle = STYLE_SPLITS.every(k => point[k] === undefined);
const hasExistingStyle = STYLE_SPLITS.every(k => Number.isFinite(existingPoint?.[k]));
if (noIncomingStyle && hasExistingStyle &&
    Math.abs(Number(existingPoint.stock) - Number(point.stock)) <= STYLE_SPLIT_EPS) {
  for (const k of STYLE_SPLITS) point[k] = Number(existingPoint[k]);
}
// A repeated run that receives no dividend event must never erase a dividend
// already verified for that ex-date.  Explicit corrections require the
// one-time audited backfill path rather than a blind daily overwrite.
for (const k of BENCH_DIV_KEYS) {
  if (point[k] === undefined && Number(existingPoint?.[k]) > 0) point[k] = Number(existingPoint[k]);
}

/*
 * Source provenance is deliberately optional, so every historical invocation
 * remains valid.  When a caller supplies only the fetch instant, derive a
 * deterministic fingerprint from every accepted input that can affect the
 * point or its cash-flow interpretation.  A caller with a stable upstream
 * revision/checksum may supply that SHA-256 value explicitly instead.
 *
 * Re-reading an unchanged source must remain byte-for-byte idempotent.  Keep
 * the first fetch instant for an unchanged fingerprint; a changed fingerprint
 * records the new instant even when the accepted portfolio values happen to
 * be equal.  A legacy caller that omits provenance keeps existing metadata only
 * for a truly unchanged point, and drops it on a correction rather than
 * presenting stale provenance as current.
 */
const stableJson = value => JSON.stringify((function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
})(value));
const withoutSourceMeta = value => Object.fromEntries(
  Object.entries(value || {}).filter(([k]) => !SOURCE_META_KEYS.has(k))
);
const existingSourceMetaValid = typeof existingPoint?.sourceFetchedAt === "string"
  && Number.isFinite(Date.parse(existingPoint.sourceFetchedAt))
  && SOURCE_FINGERPRINT_RE.test(String(existingPoint?.sourceFingerprint || ""));

if (sourceFetchedAt) {
  const canonicalIncoming = [...incoming].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const sourceFingerprint = suppliedSourceFingerprint || crypto.createHash("sha256").update(stableJson({
    point: withoutSourceMeta(point), sourceDates, benchDate: args["src-bench"] ?? null,
    acctCash, prevAcctCash, flows: canonicalIncoming
  })).digest("hex");
  point.sourceFingerprint = sourceFingerprint;
  point.sourceFetchedAt = existingSourceMetaValid
    && String(existingPoint.sourceFingerprint).toLowerCase() === sourceFingerprint
    ? new Date(existingPoint.sourceFetchedAt).toISOString()
    : sourceFetchedAt;
} else if (existingSourceMetaValid && samePoint(withoutSourceMeta(existingPoint), point)) {
  point.sourceFetchedAt = new Date(existingPoint.sourceFetchedAt).toISOString();
  point.sourceFingerprint = String(existingPoint.sourceFingerprint).toLowerCase();
}

const prior = data.daily
  .filter(x => x && typeof x.d === "string" && x.d < date)
  .sort((a, b) => a.d.localeCompare(b.d))
  .pop();
const externalAccts = new Set([...flows.auto, ...flows.unresolved].filter(f => f && f.date === date).map(f => f.acct));
hard.push(...checkMove(prior, point, externalAccts));

if (hard.length) dieAll([...hard, "nothing written"]);

const status = buildStatus({
  date, splitDelta: check.splitDelta, unresolved: flows.unresolved,
  provisional: check.provisional, calibrated
});

/* ---------- 候选 payload、计算回执与幂等 ---------- */
const existing = data.daily.filter(x => x && x.d === date);
const baseUnchanged = existing.length === 1 && samePoint(existing[0], point)
  && flows.added === 0 && flows.promoted === 0 && flows.flagged === 0
  && sameStatus(data.status, status);

const nextDaily = data.daily.filter(x => x && x.d !== date);
nextDaily.push(point);
nextDaily.sort((a, b) => String(a.d).localeCompare(String(b.d)));
const nextData = {
  ...data,
  daily: nextDaily,
  flowsAuto: flows.auto,
  flowsUnresolved: flows.unresolved,
  status
};

let receiptState = "unchanged";
if (economicInput) {
  // An unresolved cash movement makes fees and Carry non-authoritative, but it
  // must not prevent the read-only AUM point from being recorded.  Remove any
  // prior receipt and publish no replacement until the flow ledger is resolved.
  if (nextData.flowsUnresolved.length > 0) {
    if (data.feeCalculationReceipt) {
      delete nextData.feeCalculationReceipt;
      receiptState = "unavailable-removed";
    } else receiptState = "unavailable";
  } else {
    let receipt;
    try { receipt = buildFeeCalculationReceipt({ data: nextData, economicInput }); }
    catch (error) { die(`fee calculation receipt failed: ${error.message} — nothing written`); }
    if (!sameFeeCalculationReceipt(data.feeCalculationReceipt, receipt)) receiptState = "updated";
    nextData.feeCalculationReceipt = receipt;
  }
} else if (data.feeCalculationReceipt) {
  const validation = validateFeeCalculationReceipt(data.feeCalculationReceipt, nextData);
  if (!validation.ok) {
    delete nextData.feeCalculationReceipt;
    receiptState = "stale-removed";
  }
}

const receiptUnchanged = sameFeeCalculationReceipt(data.feeCalculationReceipt, nextData.feeCalculationReceipt);
if (baseUnchanged && receiptUnchanged) {
  console.log(`no-op ${date}`);
  process.exit(0);
}

/* ---------- 合并并原子写回 ---------- */
nextData.updatedAt = new Date().toISOString();

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
writeAtomic(file, JSON.stringify({ enc: true, v: 3, data: enc(JSON.stringify(nextData)) }));

console.log(
  `ok ${date} points=${nextData.daily.length} ${calibrated ? "calibrated" : (status.provisional ? "provisional" : "clean")} ` +
  `flows=${nextData.flowsAuto.length} new-flows=${flows.added} promoted=${flows.promoted} ` +
  `unresolved=${nextData.flowsUnresolved.length} receipt=${receiptState}`
);
for (const n of status.notes) console.warn(`note: ${n}`);
