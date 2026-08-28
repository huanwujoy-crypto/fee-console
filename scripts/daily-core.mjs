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
//     Long-run performance and the SPY / QQQ comparison prefer these
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
export const STYLE_SPLIT_EPS = 1;        // USD — complete look-through must reconcile within this
export const MOVE_IMPOSSIBLE = 0.5;      // 50% day-on-day with no external flow
export const MAX_LOOKBACK_DAYS = 10;     // weekend calibration reach
export const CASH_EPS = 0.01;

export const ACCOUNTS = ["schwab", "webull"];
export const SPLITS = ["cash", "stock", "other"];
// Optional style look-through.  Keep `stock` as the authoritative equity total:
// growth/value are only accepted as a complete, reconciling pair.
export const STYLE_SPLITS = ["growth", "value"];
/* 基准（口径 v4.6）：美股收盘、含息。存的是当日原始收盘价 + 当日除息金额，
   两者都写一次就永不重述——这是不用 Yahoo adjclose 的原因（见 §9.2）。
   cspx / eqac 是 v4.5 及以前的欧洲收盘口径，只读不再写，供历史数据回放。 */
export const BENCH_KEYS = ["spy", "qqq"];
export const BENCH_DIV_KEYS = ["spyd", "qqqd"];
export const BENCH_LEGACY_KEYS = ["cspx", "eqac", "eqqq"];

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
    date, accounts = {}, splits = {}, styleSplits = {}, sourceDates = {}, bench = {}, benchDiv = {},
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

  const stylePresent = STYLE_SPLITS.filter(s => styleSplits[s] !== undefined && styleSplits[s] !== null);
  if (stylePresent.length === 1) {
    errors.push("--growth and --value must be supplied together");
  } else if (stylePresent.length === STYLE_SPLITS.length) {
    for (const s of STYLE_SPLITS) {
      const v = styleSplits[s];
      if (!Number.isFinite(v)) errors.push(`--${s} must be a finite number`);
      else if (v < 0) errors.push(`--${s} must be zero or greater`);
    }
    const styleTotal = STYLE_SPLITS.reduce((sum, s) => sum + styleSplits[s], 0);
    if (Number.isFinite(styleTotal) && Number.isFinite(splits.stock) &&
        Math.abs(styleTotal - splits.stock) > STYLE_SPLIT_EPS) {
      errors.push(`growth/value split is incomplete: growth+value differs from stock by ` +
        `${(splits.stock - styleTotal).toFixed(2)} (> ${STYLE_SPLIT_EPS.toFixed(2)})`);
    }
  }

  for (const [k, v] of Object.entries(bench)) {
    if (![...BENCH_KEYS, ...BENCH_LEGACY_KEYS].includes(k)) errors.push(`unknown benchmark field --${k}`);
    else if (!Number.isFinite(v) || !(v > 0)) errors.push(`--${k} must be a number greater than 0`);
  }
  const hasNewBench = BENCH_KEYS.some(k => bench[k] !== undefined);
  const hasLegacyBench = BENCH_LEGACY_KEYS.some(k => bench[k] !== undefined);
  if (hasNewBench && BENCH_KEYS.some(k => bench[k] === undefined)) {
    errors.push(`benchmark prices must be supplied as a pair: ${BENCH_KEYS.join(" and ")}`);
  }
  if (hasLegacyBench && !(["cspx", "eqac"].every(k => bench[k] !== undefined))) {
    errors.push("legacy benchmark prices must be supplied as a pair: cspx and eqac");
  }
  if (hasNewBench && hasLegacyBench) errors.push("do not mix SPY/QQQ and legacy benchmark inputs in one run");
  // 除息金额绝大多数日子是 0，所以下界是 0 而不是 >0；负数一定是取数错误。
  for (const [k, v] of Object.entries(benchDiv)) {
    if (!BENCH_DIV_KEYS.includes(k)) errors.push(`unknown benchmark dividend field --${k}`);
    else if (!Number.isFinite(v) || v < 0) errors.push(`--${k} must be a number of zero or greater`);
    else if (bench[k.slice(0, -1)] === undefined) {
      errors.push(`--${k} needs its price --${k.slice(0, -1)} on the same day`);
    }
  }
  if (Object.keys(bench).length) {
    if (!benchDate) errors.push("--src-bench is required when benchmark prices are supplied");
    else if (!isIsoDate(benchDate)) errors.push("--src-bench must be a valid ISO calendar date");
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
    const sameDay = movements.filter(m =>
      m.acct === a && m.date === date && m.evidence !== "external_asset_transfer"
    );
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

/**
 * Immutable identity for a Sharesight in-kind transfer.  Free-form fields such
 * as desc, externalRef and a caller-supplied id are deliberately excluded:
 * scheduled runs may reword them, while the three Sharesight object ids name
 * the same business event across runs.
 */
export function inKindBusinessKey(raw) {
  if (raw.evidence !== "external_asset_transfer") return "";
  const objectId = value => {
    const text = value == null ? "" : String(value).trim();
    if (!/^\d+$/.test(text)) return "";
    const normalized = BigInt(text).toString();
    return normalized === "0" ? "" : normalized;
  };
  const sourceTradeId = objectId(raw.sourceTradeId);
  const tradeId = objectId(raw.tradeId);
  const holdingId = objectId(raw.holdingId);
  if (!sourceTradeId || !tradeId || !holdingId) return "";
  return `sharesight:${sourceTradeId}->${tradeId};holding:${holdingId}`;
}

export function classifyFlow(raw) {
  const desc = typeof raw.desc === "string" ? raw.desc : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const trade = hasTradeEvidence(raw);
  const externalRef = typeof raw.externalRef === "string" ? raw.externalRef.trim() : "";
  const businessKey = inKindBusinessKey(raw);

  // A verified in-kind transfer is the one case where a linked trade is also
  // external to the managed composite. Require both sides to agree on market
  // date, instrument and quantity before it can take effect.
  if (raw.evidence === "external_asset_transfer") {
    const normalizeInstrument = value => typeof value === "string"
      ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const sourceInstrument = normalizeInstrument(raw.sourceInstrument);
    const destinationInstrument = normalizeInstrument(raw.destinationInstrument);
    const sourceQuantity = Number(raw.sourceQuantity);
    const destinationQuantity = Number(raw.destinationQuantity);
    const quantitiesMatch = Number.isFinite(sourceQuantity) && Number.isFinite(destinationQuantity)
      && sourceQuantity !== 0 && Math.abs(Math.abs(sourceQuantity) - Math.abs(destinationQuantity)) < 1e-8
      && Number.isFinite(raw.holdingDelta)
      && Math.abs(Math.abs(raw.holdingDelta) - Math.abs(destinationQuantity)) < 1e-8;
    const paired = raw.sourceTradeId != null && raw.tradeId != null
      && String(raw.sourceTradeId) !== String(raw.tradeId)
      && raw.holdingId != null
      && raw.sourceDate === raw.date && raw.destinationDate === raw.date
      && sourceInstrument !== "" && sourceInstrument === destinationInstrument
      && quantitiesMatch;
    if (!businessKey || !paired) {
      return { kind: "unresolved", effective: false,
        reason: "external asset transfer lacks paired source/destination trade evidence" };
    }
    return { kind: "external", effective: true,
      reason: `verified external asset transfer ${businessKey}` };
  }

  if (raw.evidence === "internal_trade") return { kind: "internal", reason: "explicit evidence: internal_trade" };
  if (raw.evidence === "external_transfer") {
    if (trade) {
      return { kind: "misfiled", reason: `asserted as an external transfer but ${trade}` };
    }
    if (externalRef) {
      return { kind: "external", effective: false, reason: `explicit evidence with reference ${externalRef}` };
    }
    return { kind: "unresolved", reason: "evidence=external_transfer but no externalRef supplied" };
  }

  if (trade) return { kind: "internal", reason: trade };

  if (EXTERNAL_DESC_RE.some(re => re.test(desc))) {
    return { kind: "external", effective: false, reason: "description shows an external transfer" };
  }
  if (/^(?:deposit|withdrawal)$/i.test(type.trim())) {
    return { kind: "unresolved", reason: `bare ${type.toUpperCase()} with no trade or transfer evidence` };
  }
  return { kind: "unresolved", reason: "no evidence either way" };
}

/** Stable, idempotent identifier for a cash record. */
export function flowId(raw) {
  const businessKey = inKindBusinessKey(raw);
  const canon = businessKey ? `external_asset_transfer ${businessKey}` : [
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
    const { kind, reason, effective = false } = classifyFlow(raw);
    const businessKey = inKindBusinessKey(raw);
    // A verified in-kind transfer always uses the immutable source identity.
    // Never trust a free-form id supplied by a scheduled prompt for this case.
    const id = businessKey ? flowId(raw)
      : (raw.id != null && raw.id !== "" ? String(raw.id) : flowId(raw));
    if (kind === "misfiled") { errors.push(`flow ${raw.date} ${raw.acct}: ${reason}`); continue; }
    if (kind === "internal") continue;

    const record = { id, date: raw.date, acct: raw.acct, amount: raw.amount,
      desc: typeof raw.desc === "string" ? raw.desc : "", reason,
      effective: effective === true,
      ...(businessKey ? {
        businessKey,
        sourceTradeId: raw.sourceTradeId,
        tradeId: raw.tradeId,
        holdingId: raw.holdingId
      } : {}) };

    if (kind === "external") {
      if (businessKey && effective) {
        // De-duplicate by the business event even if an older producer chose a
        // different record id.  Distinct complete keys remain distinct events.
        if (auto.some(f => f && f.businessKey === businessKey)) continue;

        // Legacy verified rows did not persist their immutable source ids.  A
        // same-tuple match is therefore ambiguous: fail closed rather than add
        // a fourth copy or silently merge two genuine equal-value transfers.
        const sameTupleLegacy = auto.filter(f => f && f.effective === true
          && f.date === raw.date && f.acct === raw.acct
          && Number.isFinite(Number(f.amount))
          && Math.abs(Number(f.amount) - Number(raw.amount)) < 0.005
          && /^verified external asset transfer\b/.test(String(f.reason || ""))
          && !f.businessKey);
        if (sameTupleLegacy.length) {
          errors.push(`flow ${raw.date} ${raw.acct}: ambiguous legacy in-kind transfer; source ids must be repaired before writing`);
          continue;
        }
      }
      if (autoIds.has(id)) {
        const i = auto.findIndex(f => f.id === id);
        if (effective && i >= 0 && auto[i].effective !== true) {
          auto[i] = record;
          promoted++;
        }
        continue;
      }
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
export function buildPoint({ date, accounts, splits, styleSplits = {}, bench = {}, benchDiv = {}, provisional = [], calibrated = false }) {
  const point = { d: date };
  for (const a of ACCOUNTS) point[a] = accounts[a];
  for (const s of SPLITS) point[s] = splits[s];
  for (const s of STYLE_SPLITS) if (styleSplits[s] !== undefined) point[s] = styleSplits[s];
  for (const k of [...BENCH_KEYS, ...BENCH_LEGACY_KEYS]) if (bench[k] !== undefined) point[k] = bench[k];
  // 只在真有除息时落字段：绝大多数日子为 0，写进去会让 samePoint 与每日 diff 变噪。
  for (const k of BENCH_DIV_KEYS) if (Number(benchDiv[k]) > 0) point[k] = benchDiv[k];
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
