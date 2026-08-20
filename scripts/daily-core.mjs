// Pure, dependency-free logic for the daily fee-console data write.
// Kept separate from the CLI so every rule below is unit-testable without
// touching the filesystem, the clock, or the encryption key.
//
// Product positioning (see docs/daily-data-contract.md):
//   This console exists to observe a manager's ability over the long run.
//   * 每日看趋势 — on a weekday one broker may lag the other by a day.
//     That is expected. The point is written, flagged `prov` (暂估), and used
//     for the trend line.
//   * 周末自动校准 — when both brokers have settled, the routine re-runs the
//     trailing days with one valuation date per day and clears the flag.
//     Long-run performance and the CSPX / EQAC comparison prefer these
//     calibrated snapshots.
//   * 历史月份自动归档 — a month becomes history by the calendar turning over.
//     There is no settlement button, no confirmation step, nothing to click.
//
// Only obvious errors block a write:
//   1. duplicate / stale cash (a settled movement missing from the balance)
//   2. an internal trade asserted as an external cash flow
//   3. a missing account
//   4. an impossible amount

import crypto from "node:crypto";

export const SPLIT_PROVISIONAL = 1;      // USD — above this the day is 暂估
export const SPLIT_IMPOSSIBLE_RATIO = 0.02; // 2% of NAV — above this it is wrong
export const MOVE_IMPOSSIBLE = 0.5;      // 50% day-on-day with no external flow
export const MAX_LOOKBACK_DAYS = 10;     // weekend calibration reach
export const CASH_EPS = 0.01;

export const ACCOUNTS = ["schwab", "webull"];
export const SPLITS = ["cash", "stock", "other"];
export const BENCH_KEYS = ["cspx", "eqac", "eqqq"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = s => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

const NY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit"
});

/** Calendar date in America/New_York for an instant. */
export const nyDate = instant => NY_FMT.format(instant instanceof Date ? instant : new Date(instant));

/** Whole days between two ISO calendar dates (b - a). */
export const dayDiff = (a, b) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/** Saturday or Sunday in New York terms (the calibration window). */
export const isWeekend = d => {
  const wd = new Date(d + "T00:00:00Z").getUTCDay();
  return wd === 0 || wd === 6;
};

/* ------------------------------------------------------------------ *
 * Validation
 *   errors[]      -> refuse to write
 *   provisional[] -> write it, mark the day 暂估
 * ------------------------------------------------------------------ */

export function validateInputs(input) {
  const errors = [], provisional = [];
  const {
    date, accounts = {}, splits = {}, sourceDates = {}, bench = {},
    benchDate = null, calibrated = false, now
  } = input;

  if (!isIsoDate(date)) {
    errors.push(`--date must be a valid ISO calendar date (got ${JSON.stringify(date)})`);
    return { errors, provisional, total: NaN, splitTotal: NaN, splitDelta: NaN };
  }

  // The clock only guards against nonsense, not against a one-day broker lag.
  const today = nyDate(now);
  const age = dayDiff(date, today);
  if (age < 0) errors.push(`--date ${date} is in the future for New York (today is ${today})`);
  else if (age > MAX_LOOKBACK_DAYS) {
    errors.push(`--date ${date} is ${age} days behind the New York date ${today}; ` +
      `the calibration window is ${MAX_LOOKBACK_DAYS} days`);
  }

  // Missing account -> block. A lagging account -> 暂估.
  for (const a of ACCOUNTS) {
    const v = accounts[a];
    if (v === undefined || v === null) { errors.push(`missing --${a}`); continue; }
    if (!Number.isFinite(v)) errors.push(`--${a} must be a finite number`);
    else if (!(v > 0)) errors.push(`--${a} must be greater than 0`);

    const src = sourceDates[a];
    if (src === undefined || src === null || src === "") {
      provisional.push(`${a}: no source valuation date supplied`);
    } else if (!isIsoDate(src)) {
      errors.push(`--src-${a} must be a valid ISO calendar date`);
    } else if (src !== date) {
      const lag = dayDiff(src, date);
      if (lag < 0 || lag > 3) errors.push(`--src-${a}=${src} is not a plausible lag behind ${date}`);
      else provisional.push(`${a}: valued on ${src}, ${lag} day(s) behind ${date}`);
    }
  }

  for (const s of SPLITS) {
    const v = splits[s];
    if (v === undefined || v === null) { errors.push(`missing --${s} (pass 0 when the bucket is empty)`); continue; }
    if (!Number.isFinite(v)) errors.push(`--${s} must be a finite number`);
    else if (v < 0) errors.push(`--${s} must be zero or greater`);
  }

  for (const [k, v] of Object.entries(bench)) {
    if (!BENCH_KEYS.includes(k)) errors.push(`unknown benchmark field --${k}`);
    else if (!Number.isFinite(v) || !(v > 0)) errors.push(`--${k} must be a number greater than 0`);
  }
  if (Object.keys(bench).length) {
    if (benchDate && !isIsoDate(benchDate)) errors.push("--src-bench must be a valid ISO calendar date");
    else if (benchDate && benchDate !== date) {
      provisional.push(`benchmark priced on ${benchDate}, not ${date}`);
    }
  }

  const total = ACCOUNTS.reduce((s, a) => s + (Number.isFinite(accounts[a]) ? accounts[a] : NaN), 0);
  const splitTotal = SPLITS.reduce((s, k) => s + (Number.isFinite(splits[k]) ? splits[k] : NaN), 0);
  const splitDelta = total - splitTotal;

  if (Number.isFinite(total) && Number.isFinite(splitTotal)) {
    const abs = Math.abs(splitDelta);
    if (abs > Math.abs(total) * SPLIT_IMPOSSIBLE_RATIO) {
      errors.push(`split is impossible: cash+stock+other differs from schwab+webull by ` +
        `${splitDelta.toFixed(2)} (> ${(SPLIT_IMPOSSIBLE_RATIO * 100).toFixed(0)}% of the total)`);
    } else if (abs > SPLIT_PROVISIONAL) {
      provisional.push(`split off by ${splitDelta.toFixed(2)}`);
    }
  }

  if (calibrated && provisional.length === 0 && isWeekend(nyDate(now)) === false) {
    // A calibrated run outside the weekend is fine; nothing to say.
  }

  return { errors, provisional, total, splitTotal, splitDelta };
}

/**
 * Duplicate / stale cash: a movement settled in the account on the target day
 * but the reported balance still shows the pre-movement figure. This is the
 * exact shape of the 2026-08-18 Webull error.
 */
export function checkCashLedger({ date, acctCash = {}, prevAcctCash = {}, movements = [] }) {
  const errors = [];
  for (const a of ACCOUNTS) {
    const sameDay = movements.filter(m => m.acct === a && m.date === date);
    if (!sameDay.length) continue;
    const now = acctCash[a], before = prevAcctCash[a];
    if (!Number.isFinite(now) || !Number.isFinite(before)) {
      errors.push(`--acct-cash-${a} and --prev-acct-cash-${a} are required: ` +
        `${sameDay.length} cash movement(s) settled in ${a} on ${date}`);
      continue;
    }
    const moved = sameDay.reduce((s, m) => s + m.amount, 0);
    const expected = before + moved;
    if (Math.abs(now - expected) > CASH_EPS) {
      errors.push(`duplicate/stale cash in ${a} on ${date}: balance ${now.toFixed(2)} ignores ` +
        `${sameDay.length} settled movement(s) totalling ${moved.toFixed(2)} ` +
        `(expected ${expected.toFixed(2)} from ${before.toFixed(2)})`);
    }
  }
  return errors;
}

/** An impossible day-on-day jump with no external money to explain it. */
export function checkMove(prev, point, externalAccts = new Set()) {
  const errors = [];
  if (!prev) return errors;
  for (const a of ACCOUNTS) {
    const p = prev[a], n = point[a];
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(n)) continue;
    if (externalAccts.has(a)) continue;
    const move = Math.abs(n - p) / p;
    if (move > MOVE_IMPOSSIBLE) {
      errors.push(`${a} moved ${(move * 100).toFixed(1)}% versus ${prev.d} with no external flow; ` +
        `refusing an impossible amount`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ *
 * Cash-movement classification — evidence first, type last.
 * ------------------------------------------------------------------ */

const TRADE_DESC_RE = [
  /\b(?:buy|sell)\s+trade\b/i,
  /\b(?:bought|sold)\b/i,
  /\b(?:buy|sell|sale|purchase)\b[^\n]{0,40}?\d+(?:\.\d+)?\s*(?:shares?\s*)?@\s*(?:USD|HKD|\$)?\s*\d/i,
  /\b\d+(?:\.\d+)?\s*(?:shares?\s*)?@\s*(?:USD|HKD|\$)?\s*\d/i
];
const TRADE_ID_RE = /-(?:BUY|SELL)-/i;

const EXTERNAL_DESC_RE = [
  /\b(?:wire|ach|eft)\b/i,
  /\b(?:incoming|outgoing)\s+(?:transfer|payment)\b/i,
  /\bexternal\s+(?:transfer|deposit|withdrawal)\b/i,
  /\b(?:bank|counterparty)\s+transfer\b/i
];

/** True when the record carries structural proof that it is a trade. */
export function hasTradeEvidence(raw) {
  const desc = typeof raw.desc === "string" ? raw.desc : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const fid = typeof raw.foreignIdentifier === "string" ? raw.foreignIdentifier : "";
  if (raw.tradeId != null || raw.holdingId != null) return "linked to a Sharesight trade/holding id";
  if (TRADE_ID_RE.test(fid)) return "foreignIdentifier encodes a BUY/SELL execution";
  if (/^(?:buy|sell)\s*trade$/i.test(type.trim())) return `transaction type ${type}`;
  if (TRADE_DESC_RE.some(re => re.test(desc))) return "description matches a trade execution";
  if (Number.isFinite(raw.holdingDelta) && raw.holdingDelta !== 0) return "same-day holding quantity changed";
  return null;
}

export function classifyFlow(raw) {
  const desc = typeof raw.desc === "string" ? raw.desc : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const trade = hasTradeEvidence(raw);

  if (raw.evidence === "internal_trade") return { kind: "internal", reason: "explicit evidence: internal_trade" };
  if (raw.evidence === "external_transfer") {
    if (trade) {
      return { kind: "misfiled", reason: `asserted as an external transfer but ${trade}` };
    }
    if (typeof raw.externalRef === "string" && raw.externalRef.trim() !== "") {
      return { kind: "external", reason: `explicit evidence with reference ${raw.externalRef.trim()}` };
    }
    return { kind: "unresolved", reason: "evidence=external_transfer but no externalRef supplied" };
  }

  if (trade) return { kind: "internal", reason: trade };

  if (EXTERNAL_DESC_RE.some(re => re.test(desc))) {
    return { kind: "external", reason: "description shows an external transfer" };
  }
  if (/^(?:deposit|withdrawal)$/i.test(type.trim())) {
    return { kind: "unresolved", reason: `bare ${type.toUpperCase()} with no trade or transfer evidence` };
  }
  return { kind: "unresolved", reason: "no evidence either way" };
}

/** Stable, idempotent identifier for a cash record. */
export function flowId(raw) {
  const canon = [
    raw.date ?? "",
    raw.acct ?? "",
    typeof raw.amount === "number" ? raw.amount.toFixed(2) : String(raw.amount ?? ""),
    raw.foreignIdentifier ?? "",
    raw.desc ?? ""
  ].join(" ");
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/**
 * Sort incoming records. A `misfiled` record — an internal trade dressed up as
 * an external transfer — is an obvious error and aborts the write.
 */
export function reconcileFlows(existingAuto, existingUnresolved, incoming) {
  const auto = existingAuto.filter(Boolean).map(f => ({ ...f }));
  const unresolved = existingUnresolved.filter(Boolean).map(f => ({ ...f }));
  const autoIds = new Set(auto.map(f => f.id));
  const unresolvedIds = new Set(unresolved.map(f => f.id));
  const errors = [];
  let added = 0, promoted = 0, flagged = 0;

  for (const raw of incoming) {
    const id = raw.id != null && raw.id !== "" ? String(raw.id) : flowId(raw);
    const { kind, reason } = classifyFlow(raw);
    if (kind === "misfiled") { errors.push(`flow ${raw.date} ${raw.acct}: ${reason}`); continue; }
    if (kind === "internal") continue;

    const record = { id, date: raw.date, acct: raw.acct, amount: raw.amount,
      desc: typeof raw.desc === "string" ? raw.desc : "", reason };

    if (kind === "external") {
      if (autoIds.has(id)) continue;
      if (unresolvedIds.has(id)) {
        const i = unresolved.findIndex(f => f.id === id);
        if (i >= 0) unresolved.splice(i, 1);
        unresolvedIds.delete(id);
        promoted++;
      }
      auto.push(record); autoIds.add(id); added++;
    } else {
      if (unresolvedIds.has(id) || autoIds.has(id)) continue;
      unresolved.push(record); unresolvedIds.add(id); flagged++;
    }
  }
  return { auto, unresolved, added, promoted, flagged, errors };
}

/* ------------------------------------------------------------------ *
 * Point assembly
 * ------------------------------------------------------------------ */

/**
 * `prov` is only written when the day is an approximation, so a calibrated
 * weekend rewrite produces a clean point and a small diff.
 */
export function buildPoint({ date, accounts, splits, bench = {}, provisional = [], calibrated = false }) {
  const point = { d: date };
  for (const a of ACCOUNTS) point[a] = accounts[a];
  for (const s of SPLITS) point[s] = splits[s];
  for (const k of BENCH_KEYS) if (bench[k] !== undefined) point[k] = bench[k];
  const prov = !calibrated && provisional.length > 0;
  if (prov) point.prov = 1;
  return point;
}

export const samePoint = (a, b) => {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every(k => Object.is(a[k], b[k]));
};

const round2 = n => {
  const r = Number(n.toFixed(2));
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Status block consumed by the UI. `hold` means "do not show a payable
 * figure"; `provisional` only means "label it 暂估".
 */
export function buildStatus({ date, splitDelta, unresolved, provisional, calibrated }) {
  const notes = provisional.slice();
  if (unresolved.length > 0) notes.push(`${unresolved.length} unclassified cash movement(s)`);
  return {
    asOf: date,
    calibrated: !!calibrated,
    provisional: !calibrated && notes.length > 0,
    splitDelta: round2(splitDelta),
    unresolvedCount: unresolved.length,
    notes
  };
};

export const sameStatus = (a, b) => {
  if (!a || !b) return false;
  return a.asOf === b.asOf
    && a.calibrated === b.calibrated
    && a.provisional === b.provisional
    && Object.is(a.splitDelta, b.splitDelta)
    && a.unresolvedCount === b.unresolvedCount
    && JSON.stringify(a.notes || []) === JSON.stringify(b.notes || []);
};
