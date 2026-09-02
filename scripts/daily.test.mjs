import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateInputs, checkCashLedger, checkMove, classifyFlow, reconcileFlows,
  flowId, inKindBusinessKey, buildPoint, buildStatus, nyDate, dayDiff,
  SPLIT_PROVISIONAL, STYLE_SPLIT_EPS, MAX_LOOKBACK_DAYS
} from "./daily-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "daily.mjs");
const repairCli = path.join(here, "repair-brkb-20260820.mjs");
const styleMapPath = path.join(here, "..", "claude", "fee-style-mapping.json");

/* A throwaway key: never the production one. */
const TEST_KEY = crypto.randomBytes(32).toString("base64url");

const today = () => nyDate(new Date());
const shift = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const baseArgs = (over = {}) => ({
  date: over.date ?? today(),
  schwab: "598517.36",
  webull: "119026.45",
  "src-schwab": over["src-schwab"] ?? over.date ?? today(),
  "src-webull": over["src-webull"] ?? over.date ?? today(),
  cash: "263697.83",
  stock: "453845.98",
  other: "0",
  ...over
});

const run = (dir, over = {}, extra = [], envOver = {}) => {
  const args = baseArgs(over);
  const argv = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `--${k}=${v}`);
  return spawnSync(process.execPath, [cli, ...argv, `--file=${path.join(dir, "data.json")}`, ...extra], {
    encoding: "utf8",
    env: { ...process.env, FEE_DATA_KEY: TEST_KEY, ...envOver }
  });
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "daily-test-"));

const readPayload = dir => {
  const outer = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  const b = Buffer.from(outer.data, "base64");
  const key = Buffer.from(TEST_KEY, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString());
};

const writePayload = (dir, payload) => {
  const key = Buffer.from(TEST_KEY, "base64url");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  const data = Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({ enc: true, v: 3, data }));
};

const writeEconEnvelope = (dir, payload, keyText = TEST_KEY) => {
  const key = Buffer.from(keyText, "base64url");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  const data = Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
  const target = path.join(dir, "fee-console-db.encrypted.json");
  fs.writeFileSync(target, JSON.stringify({ enc: true, v: 4, data }));
  return target;
};

const econForToday = (over = {}) => ({
  v: 4,
  settings: { start: today(), mgmt: 2, carry: 20, who: "PRIVATE PERSON", ...(over.settings || {}) },
  accounts: over.accounts || [
    { id: "schwab", name: "PRIVATE SCHWAB", opening: 598517.36 },
    { id: "webull", name: "PRIVATE WEBULL", opening: 119026.45 }
  ],
  months: over.months || [],
  fees: over.fees || [{ id: "PRIVATE PAYMENT", date: today(), amount: 123, ccy: "USD", note: "PRIVATE NOTE" }]
});

const runRepair = (dir, extra = [], key = TEST_KEY) => spawnSync(
  process.execPath,
  [repairCli, `--file=${path.join(dir, "data.json")}`, ...extra],
  { encoding: "utf8", env: { ...process.env, FEE_DATA_KEY: key } }
);

const repairPayload = (legacyCount = 4) => ({
  updatedAt: "2026-08-23T02:00:00.000Z",
  daily: [{ d: "2026-08-23", schwab: 599842.51, webull: 505604.62 }],
  flowsAuto: [
    { id: "wire-kept", date: "2026-08-18", acct: "schwab", amount: 2500,
      desc: "external wire", reason: "explicit evidence with reference WIRE-1", effective: false },
    ...Array.from({ length: legacyCount }, (_, i) => ({
      id: `legacy-brkb-${i + 1}`, date: "2026-08-20", acct: "webull", amount: 387550.8,
      desc: `BRK/B FOP wording ${i + 1}`,
      reason: `verified external asset transfer legacy-${i + 1}`, effective: true
    }))
  ],
  flowsUnresolved: [],
  status: { asOf: "2026-08-23", provisional: false }
});

const NUMBERS = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}\.\d{2}\b/;
const ok = (accounts, splits, extra = {}) => validateInputs({
  date: extra.date ?? today(), accounts, splits,
  sourceDates: extra.sourceDates ?? { schwab: extra.date ?? today(), webull: extra.date ?? today() },
  bench: extra.bench ?? {}, benchDiv: extra.benchDiv ?? {}, benchDate: extra.benchDate ?? null,
  calibrated: !!extra.calibrated, now: extra.now ?? new Date()
});

/* ---------------- missing accounts block ---------------- */
test("blocks when the Schwab total is missing", () => {
  const dir = tmp();
  const r = run(dir, { schwab: undefined });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing --schwab/);
  assert.equal(fs.existsSync(path.join(dir, "data.json")), false);
});

test("blocks when the Webull total is missing", () => {
  const dir = tmp();
  const r = run(dir, { webull: undefined });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing --webull/);
  assert.equal(fs.existsSync(path.join(dir, "data.json")), false);
});

test("blocks an impossible account amount", () => {
  const dir = tmp();
  const r = run(dir, { webull: "0" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--webull must be greater than 0/);
});

/* ---------------- split buckets ---------------- */
test("accepts other=0", () => {
  const dir = tmp();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const p = readPayload(dir);
  assert.equal(p.daily.at(-1).other, 0);
  assert.equal(p.status.provisional, false);
});

test("blocks when a split bucket is omitted entirely", () => {
  const dir = tmp();
  const r = run(dir, { other: undefined });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing --other/);
});

test("a small split gap is 暂估, not a block", () => {
  const dir = tmp();
  const r = run(dir, { other: "40" });               // 40 off, well under 2% of ~717k
  assert.equal(r.status, 0, r.stderr);
  const p = readPayload(dir);
  assert.equal(p.status.provisional, true);
  assert.equal(p.daily.at(-1).prov, 1);
  assert.ok(p.status.notes.some(n => /split off by/.test(n)), JSON.stringify(p.status.notes));
});

test("an impossible split gap blocks", () => {
  const dir = tmp();
  const r = run(dir, { other: "50000" });            // > 2% of the total
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /split is impossible/);
  assert.equal(fs.existsSync(path.join(dir, "data.json")), false);
});

test("split tolerance boundary", () => {
  assert.equal(SPLIT_PROVISIONAL, 1);
  assert.deepEqual(ok({ schwab: 100, webull: 100 }, { cash: 100, stock: 99.4, other: 0 }).provisional, []);
  assert.ok(ok({ schwab: 100, webull: 100 }, { cash: 100, stock: 98.5, other: 0 }).provisional.length > 0);
});

test("accepts a complete growth/value look-through that reconciles to stock", () => {
  const dir = tmp();
  const r = run(dir, { growth: "250000", value: "203845.98" });
  assert.equal(r.status, 0, r.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(point.growth, 250000);
  assert.equal(point.value, 203845.98);
  assert.equal(point.stock, point.growth + point.value);
});

test("the approved fee style mapping has unique holding keys and classifies Webull BRK/B as value", () => {
  const mapping = JSON.parse(fs.readFileSync(styleMapPath, "utf8"));
  assert.equal(mapping.schemaVersion, 1);
  assert.deepEqual(mapping.primaryKey, ["portfolioId", "holdingId"]);
  assert.equal(mapping.unknownHoldingPolicy, "fail_closed");

  const seen = new Set();
  for (const holding of mapping.holdings) {
    assert.ok(Number.isInteger(holding.portfolioId) && holding.portfolioId > 0);
    assert.ok(Number.isInteger(holding.holdingId) && holding.holdingId > 0);
    assert.ok(["growth", "value"].includes(holding.style));
    assert.equal(typeof holding.ticker, "string");
    assert.ok(holding.ticker.length > 0);
    const key = `${holding.portfolioId}:${holding.holdingId}`;
    assert.equal(seen.has(key), false, `duplicate style key ${key}`);
    seen.add(key);
  }

  const webullBrkb = mapping.holdings.find(holding =>
    holding.portfolioId === 1350094 && holding.holdingId === 28921427);
  assert.deepEqual(
    { ticker: webullBrkb?.ticker, style: webullBrkb?.style },
    { ticker: "BRK/B", style: "value" }
  );
});

test("keeps historical input backward-compatible when style fields are absent", () => {
  const dir = tmp();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(Object.hasOwn(point, "growth"), false);
  assert.equal(Object.hasOwn(point, "value"), false);
});

test("blocks a one-sided growth/value split", () => {
  const dir = tmp();
  const r = run(dir, { growth: "250000" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--growth and --value must be supplied together/);
});

test("blocks a growth/value split that does not reconcile to stock", () => {
  const dir = tmp();
  const r = run(dir, { growth: "250000", value: "100000" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /growth\/value split is incomplete/);
});

test("blocks a negative style bucket", () => {
  const dir = tmp();
  const r = run(dir, { growth: "-1", value: "453846.98" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--growth must be zero or greater/);
});

test("style reconciliation has an independent one-dollar boundary", () => {
  assert.equal(STYLE_SPLIT_EPS, 1);
  const base = { date: today(), accounts: { schwab: 100, webull: 100 },
    splits: { cash: 50, stock: 150, other: 0 },
    sourceDates: { schwab: today(), webull: today() }, now: new Date() };
  assert.deepEqual(validateInputs({ ...base, styleSplits: { growth: 100, value: 49 } }).errors, []);
  assert.match(validateInputs({ ...base, styleSplits: { growth: 100, value: 48.99 } }).errors.join("\n"),
    /growth\/value split is incomplete/);
});

test("a same-day correction without style inputs preserves a verified pair when stock is unchanged", () => {
  const dir = tmp();
  const first = run(dir, { growth: "250000", value: "203845.98" });
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const second = run(dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no-op/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), before);
});

test("a changed stock total never carries forward stale style classification", () => {
  const dir = tmp();
  assert.equal(run(dir, { growth: "250000", value: "203845.98" }).status, 0);
  const changed = run(dir, { cash: "263597.83", stock: "453945.98" });
  assert.equal(changed.status, 0, changed.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(Object.hasOwn(point, "growth"), false);
  assert.equal(Object.hasOwn(point, "value"), false);
});

/* ---------------- source snapshot provenance ---------------- */
test("persists an RFC 3339 source fetch instant and a derived SHA-256 fingerprint", () => {
  const dir = tmp();
  const r = run(dir, { "source-fetched-at": "2026-08-28T12:30:00+08:00" });
  assert.equal(r.status, 0, r.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(point.sourceFetchedAt, "2026-08-28T04:30:00.000Z");
  assert.match(point.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test("a later read of the same source fingerprint remains byte-for-byte no-op", () => {
  const dir = tmp();
  const first = run(dir, { "source-fetched-at": "2026-08-28T04:30:00Z" });
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const second = run(dir, { "source-fetched-at": "2026-08-28T04:35:00Z" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no-op/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), before);
  assert.equal(readPayload(dir).daily.at(-1).sourceFetchedAt, "2026-08-28T04:30:00.000Z");
});

test("a same-day source revision replaces the old point and provenance", () => {
  const dir = tmp();
  assert.equal(run(dir, { "source-fetched-at": "2026-08-28T04:30:00Z" }).status, 0);
  const before = readPayload(dir).daily.at(-1);
  const revised = run(dir, {
    webull: "119126.45", cash: "263797.83", stock: "453845.98",
    "source-fetched-at": "2026-08-28T05:30:00Z"
  });
  assert.equal(revised.status, 0, revised.stderr);
  const after = readPayload(dir).daily.at(-1);
  assert.equal(after.webull, 119126.45);
  assert.equal(after.sourceFetchedAt, "2026-08-28T05:30:00.000Z");
  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
  assert.equal(readPayload(dir).daily.filter(p => p.d === today()).length, 1);
});

test("an explicit upstream SHA-256 revision is persisted verbatim", () => {
  const dir = tmp();
  const fingerprint = "a".repeat(64);
  const r = run(dir, {
    "source-fetched-at": "2026-08-28T04:30:00Z",
    "source-fingerprint": fingerprint
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readPayload(dir).daily.at(-1).sourceFingerprint, fingerprint);
});

test("a legacy no-provenance no-op preserves verified source metadata", () => {
  const dir = tmp();
  assert.equal(run(dir, { "source-fetched-at": "2026-08-28T04:30:00Z" }).status, 0);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const legacy = run(dir);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /no-op/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), before);
});

test("a legacy correction drops stale source metadata", () => {
  const dir = tmp();
  assert.equal(run(dir, { "source-fetched-at": "2026-08-28T04:30:00Z" }).status, 0);
  const legacy = run(dir, { webull: "119126.45", cash: "263797.83" });
  assert.equal(legacy.status, 0, legacy.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(Object.hasOwn(point, "sourceFetchedAt"), false);
  assert.equal(Object.hasOwn(point, "sourceFingerprint"), false);
});

test("rejects malformed or unpaired source provenance without writing", () => {
  const badTimeDir = tmp();
  const badTime = run(badTimeDir, { "source-fetched-at": "2026-08-28 12:30" });
  assert.notEqual(badTime.status, 0);
  assert.match(badTime.stderr, /RFC 3339 instant/);
  assert.equal(fs.existsSync(path.join(badTimeDir, "data.json")), false);

  const badHashDir = tmp();
  const badHash = run(badHashDir, { "source-fetched-at": "2026-08-28T04:30:00Z", "source-fingerprint": "abc" });
  assert.notEqual(badHash.status, 0);
  assert.match(badHash.stderr, /64-character SHA-256/);

  const unpairedDir = tmp();
  const unpaired = run(unpairedDir, { "source-fingerprint": "a".repeat(64) });
  assert.notEqual(unpaired.status, 0);
  assert.match(unpaired.stderr, /requires --source-fetched-at/);
});

/* ---------------- weekday lag is allowed ---------------- */
test("a one-day Schwab lag is written and flagged 暂估, not blocked", () => {
  const dir = tmp();
  const t = today();
  const r = run(dir, { "src-schwab": shift(t, -1) });
  assert.equal(r.status, 0, r.stderr);
  const p = readPayload(dir);
  assert.equal(p.daily.at(-1).prov, 1);
  assert.equal(p.status.provisional, true);
  assert.ok(p.status.notes.some(n => /schwab: valued on/.test(n)), JSON.stringify(p.status.notes));
});

test("an implausible lag still blocks", () => {
  const dir = tmp();
  const t = today();
  const r = run(dir, { "src-schwab": shift(t, -9) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a plausible lag/);
});

test("a benchmark priced on another day is 暂估", () => {
  const t = today();
  const v = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { bench: { spy: 747.03, qqq: 687.99 }, benchDate: shift(t, -1) });
  assert.deepEqual(v.errors, []);
  assert.ok(v.provisional.some(n => /benchmark priced on/.test(n)));
});

/* ---------------- weekend calibration ---------------- */
test("--calibrated clears the 暂估 flag and the point stays clean", () => {
  const dir = tmp();
  const t = today();
  const first = run(dir, { "src-schwab": shift(t, -1) });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readPayload(dir).daily.at(-1).prov, 1);

  const second = run(dir, {}, ["--calibrated"]);
  assert.equal(second.status, 0, second.stderr);
  const p = readPayload(dir);
  assert.equal("prov" in p.daily.at(-1), false, "a calibrated rewrite must drop the flag");
  assert.equal(p.status.calibrated, true);
  assert.equal(p.status.provisional, false);
  assert.match(second.stdout, /calibrated/);
});

test("the calibration window reaches back but not indefinitely", () => {
  const now = new Date("2026-08-24T02:00:00Z");          // New York 2026-08-23 (Sunday)
  assert.equal(nyDate(now), "2026-08-23");
  const inWindow = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { date: "2026-08-19", now, calibrated: true });
  assert.deepEqual(inWindow.errors, []);
  const tooOld = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { date: "2026-08-01", now, calibrated: true });
  assert.ok(tooOld.errors.some(e => /calibration window/.test(e)));
  assert.equal(MAX_LOOKBACK_DAYS, 10);
  assert.equal(dayDiff("2026-08-19", "2026-08-23"), 4);
});

/* ---------------- New York / Hong Kong cross-day ---------------- */
test("uses the New York calendar, not the Hong Kong one", () => {
  const now = new Date("2026-08-20T02:00:00Z");    // NY 2026-08-19 22:00, HK 2026-08-20 10:00
  assert.equal(nyDate(now), "2026-08-19");
  const hk = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { date: "2026-08-20", now });
  assert.ok(hk.errors.some(e => /in the future for New York/.test(e)), JSON.stringify(hk.errors));
  const ny = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { date: "2026-08-19", now });
  assert.deepEqual(ny.errors, []);
});

/* ---------------- duplicate / stale cash ---------------- */
test("blocks duplicate cash: a settled movement missing from the balance", () => {
  // The real 2026-08-18 Webull failure: sells + a buy settled, balance still pre-trade.
  const errs = checkCashLedger({
    date: "2026-08-18",
    acctCash: { webull: 12866.30 },        // stale, pre-trade
    prevAcctCash: { webull: 12866.30 },
    movements: [
      { date: "2026-08-18", acct: "webull", amount: 4034.40 },
      { date: "2026-08-18", acct: "webull", amount: 42297.00 },
      { date: "2026-08-18", acct: "webull", amount: -57833.50 }
    ]
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /duplicate\/stale cash in webull/);
});

test("accepts the correct post-trade cash balance", () => {
  const errs = checkCashLedger({
    date: "2026-08-18",
    acctCash: { webull: 1364.20 },
    prevAcctCash: { webull: 12866.30 },
    movements: [
      { date: "2026-08-18", acct: "webull", amount: 4034.40 },
      { date: "2026-08-18", acct: "webull", amount: 42297.00 },
      { date: "2026-08-18", acct: "webull", amount: -57833.50 }
    ]
  });
  assert.deepEqual(errs, []);
});

test("requires the cash pair once a movement settles that day", () => {
  const errs = checkCashLedger({
    date: "2026-08-18", acctCash: {}, prevAcctCash: {},
    movements: [{ date: "2026-08-18", acct: "webull", amount: -100 }]
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /required/);
});

test("blocks stale cash end-to-end through the CLI", () => {
  const dir = tmp();
  const t = today();
  const flows = JSON.stringify([
    { date: t, acct: "webull", amount: -57833.5, type: "WITHDRAWAL",
      desc: "SGOV buy 575 @ USD 100.58", foreignIdentifier: "wb-SGOV-BUY-cash" }
  ]);
  const r = run(dir, { "acct-cash-webull": "12866.30", "prev-acct-cash-webull": "12866.30" }, [`--flows=${flows}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate\/stale cash/);
  assert.equal(fs.existsSync(path.join(dir, "data.json")), false);
});

/* ---------------- impossible movement ---------------- */
test("blocks an impossible day-on-day jump with no external money", () => {
  const errs = checkMove({ d: "2026-08-18", schwab: 600000, webull: 100000 },
    { d: "2026-08-19", schwab: 600000, webull: 900000 }, new Set());
  assert.equal(errs.length, 1);
  assert.match(errs[0], /webull moved .* refusing an impossible amount/s);
});

test("the same jump is fine when external money explains it", () => {
  const errs = checkMove({ d: "2026-08-18", schwab: 600000, webull: 100000 },
    { d: "2026-08-19", schwab: 600000, webull: 900000 }, new Set(["webull"]));
  assert.deepEqual(errs, []);
});

/* ---------------- flow classification ---------------- */
test("an e-mail-imported sale typed DEPOSIT is an internal trade", () => {
  const c = classifyFlow({
    date: "2026-08-18", acct: "webull", amount: 42297,
    desc: "AAOI sale 300 @ USD 140.99 — Webull HK execution 2026-08-18 09:59:22 EDT",
    type: "DEPOSIT",
    foreignIdentifier: "webullhk-10205226-email-AAOI-SELL-20260818T095922EDT-300-140.9900-cash"
  });
  assert.equal(c.kind, "internal", c.reason);
});

test("an e-mail-imported buy typed WITHDRAWAL is an internal trade", () => {
  const c = classifyFlow({
    date: "2026-08-18", acct: "webull", amount: -57833.5,
    desc: "SGOV buy 575 @ USD 100.58 — Webull HK execution",
    type: "WITHDRAWAL",
    foreignIdentifier: "webullhk-10205226-email-SGOV-BUY-20260818T100015EDT-575-100.5800-cash"
  });
  assert.equal(c.kind, "internal", c.reason);
});

test("a linked Sharesight trade is internal", () => {
  const c = classifyFlow({
    date: "2026-08-17", acct: "schwab", amount: -4000,
    desc: "Buy trade of 39.7745 SGOV.NYSE shares",
    type: "Buy Trade", tradeId: 135570907, holdingId: 28771540
  });
  assert.equal(c.kind, "internal", c.reason);
});

test("a same-day holding change makes an untyped movement internal", () => {
  const c = classifyFlow({ date: "2026-08-18", acct: "webull", amount: -1000,
    desc: "adjustment", type: "WITHDRAWAL", holdingDelta: 12 });
  assert.equal(c.kind, "internal", c.reason);
});

test("a whole same-day trade set produces no flow candidates", () => {
  const trades = [
    { date: "2026-08-18", acct: "webull", amount: 4034.4, type: "DEPOSIT",
      desc: "GGLL sale 40 @ USD 100.86", foreignIdentifier: "wb-GGLL-SELL-cash" },
    { date: "2026-08-18", acct: "webull", amount: 42297, type: "DEPOSIT",
      desc: "AAOI sale 300 @ USD 140.99", foreignIdentifier: "wb-AAOI-SELL-cash" },
    { date: "2026-08-18", acct: "webull", amount: -57833.5, type: "WITHDRAWAL",
      desc: "SGOV buy 575 @ USD 100.58", foreignIdentifier: "wb-SGOV-BUY-cash" }
  ];
  const r = reconcileFlows([], [], trades);
  assert.equal(r.auto.length, 0);
  assert.equal(r.unresolved.length, 0);
  assert.deepEqual(r.errors, []);
});

test("an internal trade asserted as an external transfer is an obvious error", () => {
  const c = classifyFlow({
    date: "2026-08-18", acct: "webull", amount: -57833.5,
    desc: "SGOV buy 575 @ USD 100.58", type: "WITHDRAWAL",
    foreignIdentifier: "wb-SGOV-BUY-cash",
    evidence: "external_transfer", externalRef: "WIRE-999"
  });
  assert.equal(c.kind, "misfiled");
  const r = reconcileFlows([], [], [{ date: "2026-08-18", acct: "webull", amount: -57833.5,
    desc: "SGOV buy 575 @ USD 100.58", type: "WITHDRAWAL", foreignIdentifier: "wb-SGOV-BUY-cash",
    evidence: "external_transfer", externalRef: "WIRE-999" }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /asserted as an external transfer/);
});

test("blocks a misfiled internal trade end-to-end", () => {
  const dir = tmp();
  const t = today();
  const flows = JSON.stringify([
    { date: t, acct: "webull", amount: -57833.5, type: "WITHDRAWAL",
      desc: "SGOV buy 575 @ USD 100.58", foreignIdentifier: "wb-SGOV-BUY-cash",
      evidence: "external_transfer", externalRef: "WIRE-999" }
  ]);
  const r = run(dir, { "acct-cash-webull": "1364.20", "prev-acct-cash-webull": "59197.70" }, [`--flows=${flows}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /asserted as an external transfer/);
  assert.equal(fs.existsSync(path.join(dir, "data.json")), false);
});

test("a genuine external wire becomes a flow candidate", () => {
  const c = classifyFlow({ date: "2026-09-02", acct: "schwab", amount: 25000,
    desc: "Incoming wire transfer from HSBC current account", type: "DEPOSIT" });
  assert.equal(c.kind, "external", c.reason);
});

test("explicit external evidence still needs a reference", () => {
  assert.equal(classifyFlow({ date: "2026-09-02", acct: "schwab", amount: 25000, desc: "cash in",
    type: "DEPOSIT", evidence: "external_transfer", externalRef: "WIRE-1" }).kind, "external");
  assert.equal(classifyFlow({ date: "2026-09-02", acct: "schwab", amount: 25000, desc: "cash in",
    type: "DEPOSIT", evidence: "external_transfer" }).kind, "unresolved");
});

test("a fully paired in-kind transfer is external and immediately effective", () => {
  const c = classifyFlow({
    date: "2026-08-20", acct: "webull", amount: 387550.8,
    desc: "BRK/B 780 shares received from IB-HK by FOP; confirmed 2026-08-21 HKT",
    type: "OPENING_BALANCE", sourceTradeId: 135783050, tradeId: 135784216,
    holdingId: 28921427, holdingDelta: 780,
    sourceDate: "2026-08-20", destinationDate: "2026-08-20",
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    evidence: "external_asset_transfer",
    externalRef: "sharesight:135783050->135784216"
  });
  assert.equal(c.kind, "external", c.reason);
  assert.equal(c.effective, true);
});

test("an in-kind transfer without both Sharesight trades stays unresolved", () => {
  const c = classifyFlow({
    date: "2026-08-20", acct: "webull", amount: 387550.8,
    tradeId: 135784216, holdingId: 28921427, holdingDelta: 780,
    evidence: "external_asset_transfer",
    externalRef: "sharesight:135784216"
  });
  assert.equal(c.kind, "unresolved", c.reason);
  assert.equal(c.effective, false);
});

test("an in-kind transfer with mismatched dates, instruments or quantities stays unresolved", () => {
  const base = {
    date: "2026-08-20", acct: "webull", amount: 387550.8,
    sourceTradeId: 135783050, tradeId: 135784216, holdingId: 28921427,
    holdingDelta: 780, sourceDate: "2026-08-20", destinationDate: "2026-08-20",
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    evidence: "external_asset_transfer",
    externalRef: "sharesight:135783050->135784216"
  };
  for (const raw of [
    { ...base, sourceDate: "2026-08-19" },
    { ...base, destinationInstrument: "GOOG" },
    { ...base, destinationQuantity: 779 },
  ]) {
    const c = classifyFlow(raw);
    assert.equal(c.kind, "unresolved", c.reason);
    assert.equal(c.effective, false);
  }
});

test("a verified in-kind transfer does not require cash-balance evidence", () => {
  const errs = checkCashLedger({
    date: "2026-08-20", acctCash: {}, prevAcctCash: {},
    movements: [{ date: "2026-08-20", acct: "webull", amount: 387550.8,
      evidence: "external_asset_transfer" }]
  });
  assert.deepEqual(errs, []);
});

test("a verified in-kind transfer is stored as an effective flow", () => {
  const raw = {
    id: "ss-fop-135783050-135784216", date: "2026-08-20", acct: "webull",
    amount: 387550.8, desc: "BRK/B 780 share FOP", sourceTradeId: 135783050,
    tradeId: 135784216, holdingId: 28921427, holdingDelta: 780,
    sourceDate: "2026-08-20", destinationDate: "2026-08-20",
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    evidence: "external_asset_transfer",
    externalRef: "sharesight:135783050->135784216"
  };
  const r = reconcileFlows([], [], [raw]);
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].effective, true);
  assert.equal(r.auto[0].businessKey, "sharesight:135783050->135784216;holding:28921427");
  assert.equal(r.auto[0].id, flowId(raw), "caller-supplied ids must not control in-kind identity");
  assert.equal(r.unresolved.length, 0);
});

test("an in-kind transfer has one immutable identity across rewritten prompts", () => {
  const base = {
    date: "2026-08-20", acct: "webull", amount: 387550.8,
    sourceTradeId: 135783050, tradeId: 135784216, holdingId: 28921427,
    holdingDelta: 780, sourceDate: "2026-08-20", destinationDate: "2026-08-20",
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    evidence: "external_asset_transfer"
  };
  assert.equal(inKindBusinessKey(base), "sharesight:135783050->135784216;holding:28921427");
  assert.equal(classifyFlow(base).effective, true,
    "the immutable Sharesight ids themselves are the stable external reference");
  const variants = [
    { ...base, id: "routine-first", desc: "BRK/B FOP", externalRef: "first wording" },
    { ...base, id: "routine-second", desc: "780 shares received", externalRef: "second wording" },
    { ...base, id: "routine-third", desc: "confirmed next morning", externalRef: "third wording",
      foreignIdentifier: "changed-by-source" }
  ];
  assert.equal(new Set(variants.map(flowId)).size, 1);
  const r = reconcileFlows([], [], variants);
  assert.equal(r.auto.length, 1);
  assert.equal(r.added, 1);
  assert.deepEqual(r.errors, []);
});

test("equal-value in-kind transfers with different immutable ids stay separate", () => {
  const base = {
    date: "2026-08-20", acct: "webull", amount: 387550.8, desc: "BRK/B FOP",
    sourceTradeId: 135783050, tradeId: 135784216, holdingId: 28921427,
    holdingDelta: 780, sourceDate: "2026-08-20", destinationDate: "2026-08-20",
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    evidence: "external_asset_transfer"
  };
  const other = { ...base, sourceTradeId: 235783050, tradeId: 235784216, holdingId: 38921427 };
  const r = reconcileFlows([], [], [base, other]);
  assert.equal(r.auto.length, 2);
  assert.equal(new Set(r.auto.map(f => f.businessKey)).size, 2);
  assert.deepEqual(r.errors, []);
});

test("an ambiguous legacy in-kind row blocks the write and preserves encrypted bytes", () => {
  const dir = tmp();
  const t = today();
  assert.equal(run(dir).status, 0);
  const payload = readPayload(dir);
  payload.flowsAuto = [{
    id: "legacy-routine-id", date: t, acct: "webull", amount: 387550.8,
    desc: "BRK/B 780 share FOP", reason: "verified external asset transfer old free text",
    effective: true
  }];
  writePayload(dir, payload);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const flows = JSON.stringify([{
    id: "new-routine-id", date: t, acct: "webull", amount: 387550.8,
    desc: "same transfer, rewritten", sourceTradeId: 135783050,
    tradeId: 135784216, holdingId: 28921427, holdingDelta: 780,
    evidence: "external_asset_transfer", sourceDate: t, destinationDate: t,
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    externalRef: "another wording"
  }]);
  const r = run(dir, {}, [`--flows=${flows}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ambiguous legacy in-kind transfer/);
  assert.match(r.stderr, /nothing written/);
  assert.ok(before.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

test("the CLI accepts and stores a verified in-kind transfer without cash arguments", () => {
  const dir = tmp();
  const t = today();
  const flows = JSON.stringify([{
    id: "ss-fop-135783050-135784216", date: t, acct: "webull",
    amount: 387550.8, desc: "BRK/B 780 share FOP; confirmed next morning HKT",
    sourceTradeId: 135783050, tradeId: 135784216, holdingId: 28921427,
    holdingDelta: 780, evidence: "external_asset_transfer",
    sourceDate: t, destinationDate: t,
    sourceInstrument: "BRK.B", destinationInstrument: "BRK/B",
    sourceQuantity: 780, destinationQuantity: 780,
    externalRef: "sharesight:135783050->135784216"
  }]);
  const result = run(dir, {}, [`--flows=${flows}`]);
  assert.equal(result.status, 0, result.stderr);
  const payload = readPayload(dir);
  assert.equal(payload.flowsAuto.length, 1);
  assert.equal(payload.flowsAuto[0].effective, true);
  assert.equal(payload.flowsUnresolved.length, 0);
});

/* ---------------- unresolved: 暂估, never auto-selected, never a block ---------------- */
test("a bare DEPOSIT is unresolved, marks the day 暂估 and is never auto-selected", () => {
  const dir = tmp();
  const t = today();
  const flows = JSON.stringify([{ date: t, acct: "schwab", amount: 12345.67, desc: "", type: "DEPOSIT" }]);
  const r = run(dir, { "acct-cash-schwab": "12554.01", "prev-acct-cash-schwab": "208.34" }, [`--flows=${flows}`]);
  assert.equal(r.status, 0, r.stderr);
  const p = readPayload(dir);
  assert.equal(p.flowsAuto.length, 0, "must not auto-select an unexplained movement");
  assert.equal(p.flowsUnresolved.length, 1);
  assert.equal(p.status.provisional, true);
  assert.ok(p.status.notes.some(n => /unclassified/.test(n)));
});

test("evidence arriving later promotes an unresolved record exactly once", () => {
  const raw = { date: "2026-09-02", acct: "schwab", amount: 25000, desc: "cash in", type: "DEPOSIT" };
  const first = reconcileFlows([], [], [raw]);
  assert.equal(first.unresolved.length, 1);
  const resolved = { ...raw, evidence: "external_transfer", externalRef: "WIRE-1" };
  assert.equal(flowId(resolved), flowId(raw), "id must stay stable when evidence is added");
  const second = reconcileFlows(first.auto, first.unresolved, [resolved]);
  assert.equal(second.auto.length, 1);
  assert.equal(second.unresolved.length, 0);
  assert.equal(second.promoted, 1);
  const third = reconcileFlows(second.auto, second.unresolved, [resolved]);
  assert.equal(third.added, 0);
  assert.equal(third.promoted, 0);
});

/* ---------------- idempotency ---------------- */
test("running twice with identical input is a byte-for-byte no-op", () => {
  const dir = tmp();
  assert.equal(run(dir).status, 0);
  const bytes1 = fs.readFileSync(path.join(dir, "data.json"));
  const second = run(dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^no-op /m);
  assert.ok(bytes1.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

test("a repeated run with the same trade set stays a no-op", () => {
  const dir = tmp();
  const t = today();
  const flows = JSON.stringify([
    { date: t, acct: "webull", amount: -57833.5, type: "WITHDRAWAL",
      desc: "SGOV buy 575 @ USD 100.58", foreignIdentifier: "wb-SGOV-BUY-cash" }
  ]);
  const extra = { "acct-cash-webull": "1364.20", "prev-acct-cash-webull": "59197.70" };
  assert.equal(run(dir, extra, [`--flows=${flows}`]).status, 0);
  const bytes1 = fs.readFileSync(path.join(dir, "data.json"));
  const again = run(dir, extra, [`--flows=${flows}`]);
  assert.match(again.stdout, /^no-op /m);
  assert.ok(bytes1.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

/* ---------------- incident repair: exact, dry-run first, idempotent ---------------- */
test("the BRK/B repair dry-run validates four legacy rows without changing bytes", () => {
  const dir = tmp();
  writePayload(dir, repairPayload());
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const result = runRepair(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready canonical=0 legacy=4 apply=false/);
  assert.ok(before.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

test("the BRK/B repair replaces four legacy rows with one canonical Sharesight event", () => {
  const dir = tmp();
  writePayload(dir, repairPayload());
  const result = runRepair(dir, ["--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok repaired=3 canonical=1/);

  const payload = readPayload(dir);
  assert.equal(payload.flowsAuto.length, 2, "unrelated wire plus one BRK/B event");
  const repaired = payload.flowsAuto.find(flow => flow.businessKey);
  assert.deepEqual({
    id: repaired.id,
    businessKey: repaired.businessKey,
    sourceTradeId: repaired.sourceTradeId,
    tradeId: repaired.tradeId,
    holdingId: repaired.holdingId,
    effective: repaired.effective
  }, {
    id: "66902b9317c6feeb",
    businessKey: "sharesight:135783050->135784216;holding:28921427",
    sourceTradeId: 135783050,
    tradeId: 135784216,
    holdingId: 28921427,
    effective: true
  });

  const once = fs.readFileSync(path.join(dir, "data.json"));
  const second = runRepair(dir, ["--apply"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no-op canonical=1 legacy=0/);
  assert.ok(once.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

test("the BRK/B repair refuses an unexpected row count and preserves bytes", () => {
  const dir = tmp();
  writePayload(dir, repairPayload(3));
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const result = runRepair(dir, ["--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected four-legacy-row shape/);
  assert.ok(before.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

test("the BRK/B repair refuses the wrong key and preserves bytes", () => {
  const dir = tmp();
  writePayload(dir, repairPayload());
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const wrongKey = crypto.randomBytes(32).toString("base64url");
  const result = runRepair(dir, ["--apply"], wrongKey);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /decrypt failed/);
  assert.ok(before.equals(fs.readFileSync(path.join(dir, "data.json"))));
});

/* ---------------- hygiene ---------------- */
test("refuses a --key argument", () => {
  const dir = tmp();
  const r = run(dir, {}, [`--key=${TEST_KEY}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--key is refused/);
});

test("stdout carries no monetary amounts", () => {
  const dir = tmp();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(NUMBERS.test(r.stdout), false, `stdout leaked a figure: ${r.stdout}`);
  assert.equal(r.stdout.includes(TEST_KEY), false);
});

test("rejects unknown arguments and unknown flags", () => {
  const dir = tmp();
  assert.match(run(dir, {}, ["--sp500=123"]).stderr, /unknown argument --sp500/);
  assert.match(run(dir, {}, ["--settle"]).stderr, /unknown flag --settle/);
});

test("stores the SPY and QQQ benchmarks under their own keys", () => {
  const dir = tmp();
  const r = run(dir, { spy: "763.47", qqq: "706.32", "src-bench": today() });
  assert.equal(r.status, 0, r.stderr);
  const last = readPayload(dir).daily.at(-1);
  assert.equal(last.spy, 763.47);
  assert.equal(last.qqq, 706.32);
  assert.equal("cspx" in last, false, "SPY must not be written under the retired European key");
});

/* 除息日之外不落字段：写 0 会让 samePoint 判定为变化，每天制造一次空 diff。 */
test("a dividend is stored only on the day it goes ex", () => {
  const dir = tmp();
  const quiet = run(dir, { spy: "763.47", qqq: "706.32", spyd: "0", "src-bench": today() });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal("spyd" in readPayload(dir).daily.at(-1), false);

  const dir2 = tmp();
  const exDay = run(dir2, { spy: "768.40", qqq: "706.32", spyd: "1.903516", "src-bench": today() });
  assert.equal(exDay.status, 0, exDay.stderr);
  assert.equal(readPayload(dir2).daily.at(-1).spyd, 1.903516);
});

test("SPY and QQQ plus their source date are mandatory as a pair", () => {
  const missingPair = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { bench: { spy: 763.47 }, benchDate: today() });
  assert.ok(missingPair.errors.some(e => /must be supplied as a pair/.test(e)), missingPair.errors.join("; "));
  const missingDate = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { bench: { spy: 763.47, qqq: 706.32 } });
  assert.ok(missingDate.errors.some(e => /--src-bench is required/.test(e)), missingDate.errors.join("; "));
});

test("the old Routine can finish during migration, but may not mix benchmark systems", () => {
  const dir = tmp(), d = today();
  const legacy = run(dir, { cspx: "825.29", eqac: "497.50", "src-bench": d });
  assert.equal(legacy.status, 0, legacy.stderr);
  const point = readPayload(dir).daily.at(-1);
  assert.equal(point.cspx, 825.29);
  assert.equal(point.eqac, 497.50);
  const mixed = run(tmp(), { spy: "763.47", qqq: "706.32", cspx: "825.29", eqac: "497.50", "src-bench": d });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /do not mix SPY\/QQQ and legacy benchmark inputs/);
});

test("rerunning an ex-date without an event preserves the verified dividend", () => {
  const dir = tmp(), d = today();
  const first = run(dir, { spy: "768.40", qqq: "706.32", spyd: "1.903516", "src-bench": d });
  assert.equal(first.status, 0, first.stderr);
  const second = run(dir, { spy: "768.40", qqq: "706.32", "src-bench": d });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readPayload(dir).daily.at(-1).spyd, 1.903516);
});

/* ---------------- deterministic fee calculation receipt ---------------- */
test("an encrypted v4 economic snapshot produces a receipt inside the existing v3 envelope", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  const result = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /receipt=updated/);
  const outer = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  assert.deepEqual({ enc: outer.enc, v: outer.v }, { enc: true, v: 3 });
  const receipt = readPayload(dir).feeCalculationReceipt;
  assert.equal(receipt.schema, "fee-console.calculation-receipt.v1");
  assert.equal(receipt.asOf, today());
  assert.equal(receipt.periods[0].feeBasisDayCount, 1);
  assert.equal(receipt.periods[0].calendarDayCount, 1);
  assert.equal(receipt.status.valid, true);
});

test("the receipt never copies private Gist records into the public calculation payload", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday({
    months: [{ ym: today().slice(0, 7), flows: [{
      id: "PRIVATE-ID", src: "", date: today(), acct: "schwab",
      amount: 1, note: "PRIVATE-NOTE-MARKER"
    }]}]
  }));
  const result = run(dir, { schwab: "598518.36", cash: "263698.83" }, [], { FEE_ECON_FILE: econFile });
  assert.equal(result.status, 0, result.stderr);
  const serialized = JSON.stringify(readPayload(dir).feeCalculationReceipt);
  for (const marker of ["PRIVATE-ID", "PRIVATE-NOTE-MARKER", "PRIVATE PERSON", "PRIVATE PAYMENT"]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test("an unresolved flow records AUM but removes the fee receipt", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  assert.equal(run(dir, {}, [], { FEE_ECON_FILE: econFile }).status, 0);
  assert.ok(readPayload(dir).feeCalculationReceipt);

  const flows = JSON.stringify([{
    date: today(), acct: "schwab", amount: 12345.67, desc: "", type: "DEPOSIT"
  }]);
  const result = run(dir, {
    "acct-cash-schwab": "12554.01",
    "prev-acct-cash-schwab": "208.34"
  }, [`--flows=${flows}`], { FEE_ECON_FILE: econFile });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /receipt=unavailable-removed/);
  const payload = readPayload(dir);
  assert.equal(payload.daily.at(-1).d, today());
  assert.equal(payload.flowsUnresolved.length, 1);
  assert.equal(Object.hasOwn(payload, "feeCalculationReceipt"), false);
});

test("identical public and private inputs remain byte-for-byte no-op", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  assert.equal(run(dir, {}, [], { FEE_ECON_FILE: econFile }).status, 0);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const again = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no-op/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), before);
});

test("a private economic change updates the receipt even when the daily point is unchanged", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  assert.equal(run(dir, {}, [], { FEE_ECON_FILE: econFile }).status, 0);
  const beforeBytes = fs.readFileSync(path.join(dir, "data.json"));
  const beforeReceipt = readPayload(dir).feeCalculationReceipt;
  writeEconEnvelope(dir, econForToday({ settings: { mgmt: 2.01 } }));
  const changed = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /receipt=updated/);
  assert.notDeepEqual(fs.readFileSync(path.join(dir, "data.json")), beforeBytes);
  assert.notEqual(readPayload(dir).feeCalculationReceipt.receiptId, beforeReceipt.receiptId);
});

test("a no-economic-input run preserves a still-matching receipt", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  assert.equal(run(dir, {}, [], { FEE_ECON_FILE: econFile }).status, 0);
  const before = fs.readFileSync(path.join(dir, "data.json"));
  const withoutEcon = run(dir);
  assert.equal(withoutEcon.status, 0, withoutEcon.stderr);
  assert.match(withoutEcon.stdout, /no-op/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), before);
});

test("a public-data change without economic input removes a stale receipt", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  assert.equal(run(dir, {}, [], { FEE_ECON_FILE: econFile }).status, 0);
  assert.ok(readPayload(dir).feeCalculationReceipt);
  const changed = run(dir, { webull: "119126.45", cash: "263797.83" });
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /receipt=stale-removed/);
  assert.equal(Object.hasOwn(readPayload(dir), "feeCalculationReceipt"), false);
});

test("wrong-key, corrupt and plaintext economic inputs fail closed without changing data", () => {
  const dir = tmp();
  assert.equal(run(dir).status, 0);
  const dataFile = path.join(dir, "data.json");
  const before = fs.readFileSync(dataFile);

  const wrongKey = crypto.randomBytes(32).toString("base64url");
  const econFile = writeEconEnvelope(dir, econForToday(), wrongKey);
  const wrong = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /decrypt failed/);
  assert.deepEqual(fs.readFileSync(dataFile), before);

  fs.writeFileSync(econFile, "{broken");
  const corrupt = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /not valid JSON/);
  assert.deepEqual(fs.readFileSync(dataFile), before);

  fs.writeFileSync(econFile, JSON.stringify(econForToday()));
  const plaintext = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.notEqual(plaintext.status, 0);
  assert.match(plaintext.stderr, /encrypted v4 envelope/);
  assert.deepEqual(fs.readFileSync(dataFile), before);
});

test("existing ledger arrays cannot be silently replaced by empty arrays", () => {
  for (const field of ["daily", "flowsAuto", "flowsUnresolved"]) {
    const dir = tmp();
    const payload = {
      updatedAt: "2026-08-01T00:00:00.000Z",
      daily: [],
      flowsAuto: [],
      flowsUnresolved: [],
      [field]: { malformed: true }
    };
    writePayload(dir, payload);
    const dataFile = path.join(dir, "data.json");
    const before = fs.readFileSync(dataFile);
    const result = run(dir);
    assert.notEqual(result.status, 0, `${field} unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`${field} must be an array`));
    assert.deepEqual(fs.readFileSync(dataFile), before, `${field} failure changed bytes`);
  }

  for (const field of ["daily", "flowsAuto", "flowsUnresolved"]) {
    const dir = tmp();
    const payload = {
      updatedAt: "2026-08-01T00:00:00.000Z",
      daily: [],
      flowsAuto: [],
      flowsUnresolved: [],
      [field]: [null]
    };
    writePayload(dir, payload);
    const dataFile = path.join(dir, "data.json");
    const before = fs.readFileSync(dataFile);
    const result = run(dir);
    assert.notEqual(result.status, 0, `${field} null member unexpectedly passed`);
    assert.match(result.stderr, new RegExp(`${field}\\[0\\] must be an object`));
    assert.deepEqual(fs.readFileSync(dataFile), before, `${field} member failure changed bytes`);
  }
});

test("malformed existing status and private ledgers fail before reconciliation", () => {
  const dir = tmp();
  const dataFile = path.join(dir, "data.json");
  const incompleteStatus = {
    updatedAt: "2026-08-01T00:00:00.000Z",
    daily: [],
    flowsAuto: [],
    flowsUnresolved: [],
    status: {}
  };
  writePayload(dir, incompleteStatus);
  let before = fs.readFileSync(dataFile);
  let result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status\.asOf is missing/);
  assert.deepEqual(fs.readFileSync(dataFile), before);

  const malformedStatus = {
    updatedAt: "2026-08-01T00:00:00.000Z",
    daily: [],
    flowsAuto: [],
    flowsUnresolved: [],
    status: {
      asOf: today(), provisional: "true", calibrated: false,
      splitDelta: 0, unresolvedCount: 0, notes: []
    }
  };
  writePayload(dir, malformedStatus);
  before = fs.readFileSync(dataFile);
  result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status\.provisional must be a boolean/);
  assert.deepEqual(fs.readFileSync(dataFile), before);

  const valid = { ...malformedStatus, status: {
    asOf: today(), provisional: false, calibrated: false,
    splitDelta: 0, unresolvedCount: 0, notes: []
  } };
  writePayload(dir, valid);
  const econFile = writeEconEnvelope(dir, { ...econForToday(), fees: {} });
  before = fs.readFileSync(dataFile);
  const flows = JSON.stringify([{
    date: today(), acct: "schwab", amount: 12345.67, desc: "", type: "DEPOSIT"
  }]);
  result = run(dir, {}, [`--flows=${flows}`], { FEE_ECON_FILE: econFile });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /economic input rejected: economic input fees must be an array/);
  assert.deepEqual(fs.readFileSync(dataFile), before);
});

test("economic input is accepted only from an absolute repository-external file", () => {
  const dir = tmp();
  const relative = run(dir, {}, [], { FEE_ECON_FILE: "relative.json" });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute path/);

  const inside = run(dir, {}, [], { FEE_ECON_FILE: path.resolve(here, "..", "data.json") });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside the repository/);
});

test("receipt status output contains no monetary amount or private input", () => {
  const dir = tmp();
  const econFile = writeEconEnvelope(dir, econForToday());
  const result = run(dir, {}, [], { FEE_ECON_FILE: econFile });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, NUMBERS);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|598517|119026|fee-console-db/i);
});

test("a dividend without its price is refused, and a negative one too", () => {
  const orphan = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { bench: { qqq: 706.32 }, benchDiv: { spyd: 1.9 } });
  assert.ok(orphan.errors.some(e => /--spyd needs its price --spy/.test(e)), orphan.errors.join("; "));

  const negative = ok({ schwab: 1, webull: 1 }, { cash: 2, stock: 0, other: 0 },
    { bench: { spy: 763.47 }, benchDiv: { spyd: -1 } });
  assert.ok(negative.errors.some(e => /--spyd must be a number of zero or greater/.test(e)), negative.errors.join("; "));
});

test("buildPoint omits prov when nothing is provisional", () => {
  const clean = buildPoint({ date: "2026-08-19", accounts: { schwab: 1, webull: 2 },
    splits: { cash: 3, stock: 0, other: 0 }, provisional: [] });
  assert.equal("prov" in clean, false);
  const est = buildPoint({ date: "2026-08-19", accounts: { schwab: 1, webull: 2 },
    splits: { cash: 3, stock: 0, other: 0 }, provisional: ["lag"] });
  assert.equal(est.prov, 1);
  const cal = buildPoint({ date: "2026-08-19", accounts: { schwab: 1, webull: 2 },
    splits: { cash: 3, stock: 0, other: 0 }, provisional: ["lag"], calibrated: true });
  assert.equal("prov" in cal, false);
  assert.equal(buildStatus({ date: "2026-08-19", splitDelta: 0, unresolved: [], provisional: ["lag"], calibrated: true }).provisional, false);
});
