import crypto from "node:crypto";
import { createLegacyPolicy } from "./fee-legacy-policy.mjs";

import {
  computeFeeStatement,
  endOfMonth,
  inclusiveDays,
  isCalendarDate
} from "./fee-engine.mjs";

export const FEE_RECEIPT_SCHEMA = "fee-console.calculation-receipt.v1";
export const FEE_LEGACY_RECEIPT_SCHEMA = "fee-console.calculation-receipt.v2";
export const FEE_ENGINE_VERSION = "fee-v4.6.1";

const legacyPolicy = createLegacyPolicy();
const MAX_LEGACY_BYTES = 5 * 1024 * 1024;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const HASH_RE = /^[a-f0-9]{64}$/;
const YM_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RATE_MAX_PPM = 1_000_000;
const ACCOUNT_IDS = ["schwab", "webull"];
const ALLOWED_PROVISIONAL_CODES = new Set(["daily-provisional", "status-provisional"]);
const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const finite = (value, label) => {
  let parsed;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && value.trim() !== "" && NUMBER_RE.test(value.trim())) parsed = Number(value);
  else throw new Error(`${label} must be a finite number`);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
};

const safeInteger = (value, label) => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside the safe integer range`);
  return value;
};

const cents = (value, label = "amount") => safeInteger(Math.round(finite(value, label) * 100), `${label} cents`);

const ratePpm = (percent, label) => {
  const value = finite(percent, label);
  if (value < 0) throw new Error(`${label} cannot be negative`);
  const ppm = Math.round(value * 10_000);
  if (Math.abs(value * 10_000 - ppm) > 1e-8) throw new Error(`${label} has more than four decimal places`);
  if (ppm > RATE_MAX_PPM) throw new Error(`${label} cannot exceed 100%`);
  return ppm;
};

const applyPpm = (amountCents, ppm, divisor = 1) => safeInteger(
  Math.round((amountCents / divisor) * (ppm / 1_000_000)),
  "rate result"
);

const addDay = value => new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function canonicalJson(value) {
  const canonical = input => {
    if (Array.isArray(input)) return input.map(canonical);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
  };
  return JSON.stringify(canonical(value));
}

export const semanticHash = (domain, value) => crypto.createHash("sha256")
  .update(`fee-console:${domain}:v1\0`)
  .update(canonicalJson(value))
  .digest("hex");

/** Re-project declared copy provenance before it can enter the fee engine.
 * This key-free check establishes exact-source commitments and projection
 * consistency, not ciphertext authentication or source freshness. The writer
 * and reporter must also authenticate the original envelope with the existing
 * key; the phone checks its freshly read raw source before accepting v2.
 * A malformed/unknown declared copy must never fall back to native-v4 v1.
 */
export function legacySourceBindingForEconomicInput(raw) {
  let sourceBytes, payloadBytes;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid economic object");
    }
    if (!Object.hasOwn(raw, "legacyV3Copy")) {
      if (raw.v === 3 || "legacyV3Copy" in raw) throw new Error("unprojected legacy source");
      return null;
    }
    const exact = (value, required) => {
      if (!value || typeof value !== "object" || Array.isArray(value)
          || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...required].sort())) {
        throw new Error("invalid source fields");
      }
    };
    const bytes = value => {
      if (typeof value !== "string" || value.length > Math.ceil(MAX_LEGACY_BYTES / 3) * 4
          || !BASE64_RE.test(value)) throw new Error("invalid source bytes");
      const decoded = Buffer.from(value, "base64");
      if (!decoded.length || decoded.length > MAX_LEGACY_BYTES || decoded.toString("base64") !== value) {
        throw new Error("invalid source bytes");
      }
      return decoded;
    };
    exact(raw, ["v", "updatedAt", "settings", "accounts", "months", "fees", "legacyV3Copy"]);
    if (raw.v !== 4) throw new Error("invalid copy version");
    const provenance = raw.legacyV3Copy;
    const legacy = provenance?.schema === "fee-console.economic-v3-copy.v2"
      && provenance?.policy === legacyPolicy.LEGACY_POLICY_ID;
    const strict = provenance?.schema === "fee-console.economic-v3-copy.v1"
      && provenance?.policy === legacyPolicy.STRICT_POLICY_ID;
    if (!legacy && !strict) throw new Error("unsupported copy policy");
    exact(provenance, ["schema", "policy", "sourceEnvelopeBase64", "sourcePayloadBase64",
      ...(legacy ? ["paymentIds", "legacyRecords"] : [])]);
    sourceBytes = bytes(provenance.sourceEnvelopeBase64);
    payloadBytes = bytes(provenance.sourcePayloadBase64);
    const envelope = legacyPolicy.parseExactJson(sourceBytes);
    exact(envelope, ["enc", "v", "data"]);
    if (envelope.enc !== true || envelope.v !== 3 || typeof envelope.data !== "string"
        || !BASE64_RE.test(envelope.data)) throw new Error("invalid source envelope");
    const sealed = Buffer.from(envelope.data, "base64");
    if (sealed.length < 29 || sealed.toString("base64") !== envelope.data) {
      throw new Error("invalid source ciphertext");
    }
    const projected = legacyPolicy.projectV3(legacyPolicy.parseExactJson(payloadBytes), provenance.policy);
    const { legacyV3Copy, ...economic } = raw;
    if (canonicalJson(economic) !== canonicalJson(projected.economic)) {
      throw new Error("source projection mismatch");
    }
    if (legacy && (JSON.stringify(provenance.paymentIds) !== JSON.stringify(projected.paymentIds)
        || JSON.stringify(provenance.legacyRecords) !== JSON.stringify(projected.legacyRecords))) {
      throw new Error("source fee partition mismatch");
    }
    if (strict) return null;
    return {
      policyId: legacyPolicy.LEGACY_POLICY_ID,
      sourceEnvelopeSha256: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
      sourcePayloadSha256: crypto.createHash("sha256").update(payloadBytes).digest("hex")
    };
  } catch {
    // Never echo private field names/values, source bytes, or parsing errors.
    throw new Error("legacy economic source is invalid or unsupported");
  } finally {
    sourceBytes?.fill(0);
    payloadBytes?.fill(0);
  }
}

const normalizePrivateFlow = (flow, label) => {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) throw new Error(`${label} must be an object`);
  const id = String(flow.id || "").trim();
  if (!id) throw new Error(`${label} is missing id`);
  const date = String(flow.date || "");
  if (!isCalendarDate(date)) throw new Error(`${label} has an invalid date`);
  const amount = finite(flow.amount, `${label}.amount`);
  if (amount === 0) throw new Error(`${label}.amount cannot be zero`);
  return {
    id,
    src: String(flow.src || "").trim(),
    date,
    acct: String(flow.acct || ""),
    amount,
    note: String(flow.note || "")
  };
};

const normalizePayment = (fee, index, fxMap) => {
  const label = `payment #${index + 1}`;
  if (!fee || typeof fee !== "object" || Array.isArray(fee)) throw new Error(`${label} must be an object`);
  const id = String(fee.id || "").trim();
  if (!id) throw new Error(`${label} is missing id`);
  const date = String(fee.date || "");
  if (!isCalendarDate(date)) throw new Error(`${label} has an invalid date`);
  const amount = finite(fee.amount, `${label}.amount`);
  const ccy = String(fee.ccy || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(ccy)) throw new Error(`${label} has an invalid currency`);
  const explicit = fee.fx !== undefined && String(fee.fx).trim() !== "" ? finite(fee.fx, `${label}.fx`) : null;
  const fallback = Object.hasOwn(fxMap, ccy)
    ? finite(fxMap[ccy], `settings.fx.${ccy}`)
    : (ccy === "USD" ? 1 : null);
  const fx = explicit ?? fallback;
  if (!(fx > 0)) throw new Error(`${label} is missing a positive USD FX rate for ${ccy}`);
  // Free-form payment notes are deliberately excluded: they do not affect the
  // amount paid and therefore must not churn an otherwise identical receipt.
  return { id, date, amount, ccy, fx };
};

const requireUnique = (records, selector, label) => {
  const seen = new Set();
  for (const record of records) {
    const value = selector(record);
    if (!value) continue;
    if (seen.has(value)) throw new Error(`${label} is duplicated`);
    seen.add(value);
  }
};

export function normalizeEconomicInputs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("economic input must be an object");
  const settings = raw.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("economic input is missing settings");
  }
  const start = String(settings.start || "");
  if (!isCalendarDate(start)) throw new Error("economic input has an invalid start date");
  const managementRatePpm = ratePpm(settings.mgmt, "settings.mgmt");
  const carryRatePpm = ratePpm(settings.carry, "settings.carry");

  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    throw new Error("economic input is missing accounts");
  }
  const accounts = raw.accounts.map((account, index) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new Error(`account #${index + 1} must be an object`);
    }
    const id = String(account.id || "");
    if (!id) throw new Error(`account #${index + 1} is missing id`);
    const opening = finite(account.opening, `account #${index + 1}.opening`);
    if (opening < 0) throw new Error(`account #${index + 1}.opening cannot be negative`);
    return { id, opening };
  }).sort((left, right) => codeUnitCompare(left.id, right.id));
  requireUnique(accounts, account => account.id, "account id");
  if (canonicalJson(accounts.map(account => account.id)) !== canonicalJson(ACCOUNT_IDS)) {
    throw new Error("economic input account ids do not match the managed composite");
  }

  if (raw.months !== undefined && !Array.isArray(raw.months)) {
    throw new Error("economic input months must be an array");
  }
  const months = (raw.months || []).map((month, monthIndex) => {
    if (!month || typeof month !== "object" || Array.isArray(month)) {
      throw new Error(`month #${monthIndex + 1} must be an object`);
    }
    const ym = String(month.ym || "");
    if (!YM_RE.test(ym)) throw new Error(`month #${monthIndex + 1} has an invalid ym`);
    if (month.flows !== undefined && !Array.isArray(month.flows)) {
      throw new Error(`month ${ym} flows must be an array`);
    }
    const flows = (month.flows || [])
      .map((flow, flowIndex) => normalizePrivateFlow(flow, `month ${ym} flow #${flowIndex + 1}`))
      .sort((left, right) => codeUnitCompare(canonicalJson(left), canonicalJson(right)));
    return { ym, flows };
  }).sort((left, right) => codeUnitCompare(left.ym, right.ym));
  requireUnique(months, month => month.ym, "month");

  const confirmed = months.flatMap(month => month.flows);
  requireUnique(confirmed, flow => flow.id, "confirmed flow id");
  requireUnique(confirmed, flow => flow.src, "confirmed flow src");
  const accountIds = new Set(accounts.map(account => account.id));
  if (confirmed.some(flow => !accountIds.has(flow.acct))) {
    throw new Error("economic input has a confirmed flow with an unknown account id");
  }

  if (settings.fx !== undefined
      && (!settings.fx || typeof settings.fx !== "object" || Array.isArray(settings.fx))) {
    throw new Error("settings.fx must be an object");
  }
  const fxMap = settings.fx || {};
  if (raw.fees !== undefined && !Array.isArray(raw.fees)) {
    throw new Error("economic input fees must be an array");
  }
  const fees = (raw.fees || [])
    .map((fee, index) => normalizePayment(fee, index, fxMap))
    .sort((left, right) => codeUnitCompare(canonicalJson(left), canonicalJson(right)));
  requireUnique(fees, fee => fee.id, "payment id");

  return {
    settings: {
      start,
      mgmt: managementRatePpm / 10_000,
      carry: carryRatePpm / 10_000
    },
    accounts,
    months,
    fees
  };
}

const normalizeAutoFlow = (flow, index) => {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) throw new Error(`automatic flow #${index + 1} must be an object`);
  const date = String(flow.date || "");
  if (!isCalendarDate(date)) throw new Error(`automatic flow #${index + 1} has an invalid date`);
  return {
    id: String(flow.id || "").trim(),
    date,
    acct: String(flow.acct || ""),
    amount: finite(flow.amount, `automatic flow #${index + 1}.amount`),
    desc: String(flow.desc || ""),
    reason: String(flow.reason || ""),
    effective: flow.effective === true,
    businessKey: String(flow.businessKey || "").trim()
  };
};

const latestDailyDate = data => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("data input must be an object");
  }
  if (!Array.isArray(data.daily)) throw new Error("data input daily must be an array");
  for (const [index, point] of data.daily.entries()) {
    if (!point || typeof point !== "object" || Array.isArray(point)
        || !isCalendarDate(String(point.d || ""))) {
      throw new Error(`daily point #${index + 1} has an invalid date`);
    }
  }
  return data.daily.map(point => String(point.d)).sort().at(-1) || "";
};

export function normalizeDataInputs(data, { start, asOf, accountIds }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data input must be an object");
  if (!isCalendarDate(start) || !isCalendarDate(asOf) || asOf < start) throw new Error("invalid data-input date range");
  if (!Array.isArray(accountIds) || !accountIds.length || accountIds.some(id => !id)) {
    throw new Error("data-input account ids are invalid");
  }
  const sortedAccountIds = [...accountIds].sort();
  if (new Set(sortedAccountIds).size !== sortedAccountIds.length) throw new Error("data-input account ids are duplicated");
  if (canonicalJson(sortedAccountIds) !== canonicalJson(ACCOUNT_IDS)) {
    throw new Error("data-input account ids do not match the managed composite");
  }
  for (const field of ["daily", "flowsAuto", "flowsUnresolved"]) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      throw new Error(`data input ${field} must be an array`);
    }
  }
  const unresolvedFlows = data.flowsUnresolved || [];
  for (const [index, flow] of unresolvedFlows.entries()) {
    if (!flow || typeof flow !== "object" || Array.isArray(flow)) {
      throw new Error(`unresolved flow #${index + 1} must be an object`);
    }
  }
  const allDaily = data.daily || [];
  for (const [index, point] of allDaily.entries()) {
    if (!point || typeof point !== "object" || Array.isArray(point) || !isCalendarDate(String(point.d || ""))) {
      throw new Error(`daily point #${index + 1} has an invalid date`);
    }
  }
  requireUnique(allDaily, point => String(point.d), "daily date");
  const daily = allDaily
    .filter(point => point.d >= start && point.d <= asOf)
    .map(point => {
      const accounts = sortedAccountIds.map(id => {
        const value = finite(point[id], `daily ${point.d}.${id}`);
        if (value < 0) throw new Error(`daily ${point.d}.${id} cannot be negative`);
        return { id, value };
      });
      return { d: point.d, accounts, provisional: point.prov ? true : false };
    })
    .sort((left, right) => codeUnitCompare(left.d, right.d));

  const flowsAuto = (data.flowsAuto || [])
    .map(normalizeAutoFlow)
    .filter(flow => flow.date >= start && flow.date <= asOf)
    .sort((left, right) => codeUnitCompare(canonicalJson(left), canonicalJson(right)));
  if (flowsAuto.some(flow => !flow.id)) throw new Error("automatic flow is missing id");
  if (flowsAuto.some(flow => !sortedAccountIds.includes(flow.acct))) {
    throw new Error("automatic flow has an unknown account id");
  }
  for (const flow of flowsAuto) {
    if (flow.effective && !flow.businessKey) {
      throw new Error("effective automatic flow is missing immutable business identity");
    }
    if (flow.businessKey) {
      const expectedId = crypto.createHash("sha256")
        .update(`external_asset_transfer ${flow.businessKey}`)
        .digest("hex")
        .slice(0, 16);
      if (!flow.effective || flow.id !== expectedId
          || flow.reason !== `verified external asset transfer ${flow.businessKey}`) {
        throw new Error("automatic in-kind flow identity is inconsistent");
      }
    }
  }
  requireUnique(flowsAuto, flow => flow.id, "automatic flow id");
  requireUnique(flowsAuto, flow => flow.businessKey, "automatic flow business key");

  const status = data?.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("status must be an object");
  }
  if (typeof status.provisional !== "boolean") throw new Error("status.provisional must be a boolean");
  if (typeof status.calibrated !== "boolean") throw new Error("status.calibrated must be a boolean");
  if (!Number.isInteger(status.unresolvedCount) || status.unresolvedCount < 0) {
    throw new Error("status.unresolvedCount must be a non-negative integer");
  }
  const unresolvedCount = unresolvedFlows.length;
  if (status.unresolvedCount !== unresolvedCount) {
    throw new Error("status unresolved count does not match the unresolved-flow ledger");
  }
  if (String(status.asOf || "") !== asOf) throw new Error("status does not cover receipt asOf");
  return {
    start,
    asOf,
    accountIds: sortedAccountIds,
    daily,
    flowsAuto,
    status: {
      asOf,
      provisional: status.provisional,
      calibrated: status.calibrated,
      unresolvedCount
    }
  };
}

const validateFlowLedger = (econ, normalizedData) => {
  const confirmed = econ.months
    .flatMap(month => month.flows)
    .filter(flow => flow.date >= normalizedData.start && flow.date <= normalizedData.asOf);
  const autoById = new Map(normalizedData.flowsAuto.map(flow => [flow.id, flow]));
  for (const flow of confirmed) {
    if (!flow.src) continue;
    const automatic = autoById.get(flow.src);
    if (!automatic) throw new Error("confirmed flow src does not identify an automatic flow in the covered ledger");
    const amountGapCents = Math.abs(cents(flow.amount, "confirmed flow amount") - cents(automatic.amount, "automatic flow amount"));
    if (flow.date !== automatic.date || flow.acct !== automatic.acct || amountGapCents !== 0) {
      throw new Error("confirmed flow src disagrees with automatic flow date, account, or amount");
    }
  }
};

const effectiveFlowDigest = flows => flows.map((flow, index) => {
  const economic = {
    date: String(flow.date || ""),
    acct: String(flow.acct || ""),
    amountCents: cents(flow.amount, `effective flow #${index + 1}.amount`)
  };
  const identity = {
    id: String(flow.id || ""),
    src: String(flow.src || ""),
    reason: String(flow.reason || ""),
    note: String(flow.note || "")
  };
  return { ...economic, eventKeyHash: semanticHash("effective-flow-event", identity) };
}).sort((left, right) => codeUnitCompare(canonicalJson(left), canonicalJson(right)));

const paymentDigest = (fees, start, asOf) => fees
  .filter(fee => fee.date >= start && fee.date <= asOf)
  .map(fee => ({
    date: fee.date,
    amountCents: cents(fee.amount, "payment amount"),
    ccy: fee.ccy,
    fxPpb: safeInteger(Math.round(fee.fx * 1_000_000_000), "payment FX")
  }))
  .sort((left, right) => codeUnitCompare(canonicalJson(left), canonicalJson(right)));

const receiptPeriod = (row, finalAsOf, managementRatePpm, carryRatePpm, chain) => {
  const openingCents = cents(row.opening, `${row.ym}.opening`);
  const closingCents = cents(row.closing, `${row.ym}.closing`);
  const flowNetCents = cents(row.flowTotal, `${row.ym}.flowTotal`);
  const grossPnlCents = cents(row.grossPnl, `${row.ym}.grossPnl`);
  if (grossPnlCents !== closingCents - openingCents - flowNetCents) {
    throw new Error(`${row.ym} rounded P&L identity does not balance`);
  }
  const feeBaseSumCents = cents(row.feeBaseSum, `${row.ym}.feeBaseSum`);
  const averageFeeBaseCents = safeInteger(Math.round(feeBaseSumCents / row.calendarDayCount), `${row.ym}.averageFeeBase`);
  const managementFeeCents = applyPpm(feeBaseSumCents, managementRatePpm, 365);
  if (managementFeeCents !== cents(row.managementFee, `${row.ym}.managementFee`)) {
    throw new Error(`${row.ym} management-fee rounding is inconsistent`);
  }
  const cumulativePnlBeforeCents = chain.cumulativePnlCents;
  const highWaterBeforeCents = chain.highWaterCents;
  const cumulativePnlAfterCents = safeInteger(cumulativePnlBeforeCents + grossPnlCents, `${row.ym}.cumulativePnlAfter`);
  const highWaterAfterCents = Math.max(highWaterBeforeCents, cumulativePnlAfterCents);
  const carryCents = applyPpm(Math.max(0, cumulativePnlAfterCents - highWaterBeforeCents), carryRatePpm);
  if (carryCents !== cents(row.carry, `${row.ym}.carry`)) {
    throw new Error(`${row.ym} Carry rounding is inconsistent`);
  }
  const totalFeeCents = safeInteger(managementFeeCents + carryCents, `${row.ym}.totalFee`);
  const dietzDenominatorCents = cents(row.dietzDenominator, `${row.ym}.dietzDenominator`);
  const grossTwrPpm = safeInteger(Math.round(finite(row.grossTwr, `${row.ym}.grossTwr`) * 1_000_000), `${row.ym}.grossTwr`);
  const investorDietzPpm = safeInteger(
    Math.round(((grossPnlCents - totalFeeCents) / dietzDenominatorCents) * 1_000_000),
    `${row.ym}.investorDietz`
  );
  chain.cumulativePnlCents = cumulativePnlAfterCents;
  chain.highWaterCents = highWaterAfterCents;
  return {
    ym: row.ym,
    from: row.from,
    to: row.to,
    state: row.to === finalAsOf && finalAsOf < endOfMonth(row.ym) ? "in-progress" : "complete",
    openingCents,
    closingCents,
    flowNetCents,
    grossPnlCents,
    feeBaseSumCents,
    averageFeeBaseCents,
    managementFeeCents,
    carryCents,
    totalFeeCents,
    dietzDenominatorCents,
    grossTwrPpm,
    investorDietzPpm,
    feeBasisDayCount: row.feeBasisDayCount,
    calendarDayCount: row.calendarDayCount,
    mgmtValid: row.mgmtValid === true,
    cumulativePnlBeforeCents,
    cumulativePnlAfterCents,
    highWaterBeforeCents,
    highWaterAfterCents
  };
};

const provisionalCodesFor = normalizedData => {
  const codes = [];
  if (normalizedData.daily.some(point => point.provisional)) codes.push("daily-provisional");
  if (normalizedData.status.provisional) codes.push("status-provisional");
  return codes;
};

export function buildFeeCalculationReceipt({ data, economicInput, asOf }) {
  const legacySource = legacySourceBindingForEconomicInput(economicInput);
  const econ = normalizeEconomicInputs(economicInput);
  const newest = latestDailyDate(data);
  const finalAsOf = asOf || newest;
  if (!isCalendarDate(String(finalAsOf || ""))) throw new Error("cannot determine receipt asOf");
  if (finalAsOf !== newest) throw new Error("receipt asOf must equal the latest daily valuation date");
  if (finalAsOf < econ.settings.start) throw new Error("receipt asOf is before the fee start date");
  const accountIds = econ.accounts.map(account => account.id);
  const normalizedData = normalizeDataInputs(data, { start: econ.settings.start, asOf: finalAsOf, accountIds });
  if (normalizedData.status.unresolvedCount > 0) throw new Error("unresolved flows prevent an authoritative fee receipt");
  validateFlowLedger(econ, normalizedData);

  // The engine must consume the same canonical flow identities that passed the
  // trust-boundary checks.  Feeding raw rows here could make benign formatting
  // differences (for example surrounding id whitespace) defeat src de-duplication.
  const statement = computeFeeStatement({
    daily: data.daily,
    flowsAuto: normalizedData.flowsAuto,
    econ,
    asOf: finalAsOf
  });
  const managementRatePpm = ratePpm(econ.settings.mgmt, "settings.mgmt");
  const carryRatePpm = ratePpm(econ.settings.carry, "settings.carry");
  const chain = { cumulativePnlCents: 0, highWaterCents: 0 };
  const periods = statement.rows.map(row => receiptPeriod(row, finalAsOf, managementRatePpm, carryRatePpm, chain));
  if (periods.some(period => !period.mgmtValid || period.feeBasisDayCount !== period.calendarDayCount)) {
    throw new Error("management-fee basis is incomplete");
  }

  const flowDigest = effectiveFlowDigest(statement.flows);
  const paymentInputs = paymentDigest(econ.fees, econ.settings.start, finalAsOf);
  const grossPnlCents = periods.reduce((sum, period) => sum + period.grossPnlCents, 0);
  const managementFeeCents = periods.reduce((sum, period) => sum + period.managementFeeCents, 0);
  const carryCents = periods.reduce((sum, period) => sum + period.carryCents, 0);
  const totalFeeCents = safeInteger(managementFeeCents + carryCents, "total fees");
  const netPnlCents = safeInteger(grossPnlCents - totalFeeCents, "net P&L");
  const dietzDenominatorCents = cents(statement.totals.dietzDenominator, "total Dietz denominator");
  const grossTwrPpm = safeInteger(Math.round(
    (periods.reduce((index, period) => index * (1 + period.grossTwrPpm / 1_000_000), 1) - 1) * 1_000_000
  ), "total gross TWR");
  const investorDietzPpm = safeInteger(Math.round(
    (netPnlCents / dietzDenominatorCents) * 1_000_000
  ), "total investor Dietz");
  const paidCents = cents(statement.balance.paid, "paid fees");
  const provisionalCodes = provisionalCodesFor(normalizedData);
  const body = {
    schema: legacySource ? FEE_LEGACY_RECEIPT_SCHEMA : FEE_RECEIPT_SCHEMA,
    engineVersion: FEE_ENGINE_VERSION,
    asOf: finalAsOf,
    start: econ.settings.start,
    accountIds: [...accountIds].sort(),
    managementRatePpm,
    carryRatePpm,
    dataInputsHash: semanticHash("public-calculation-inputs", normalizedData),
    econInputsHash: semanticHash("private-economic-inputs", econ),
    paymentInputsHash: semanticHash("payment-inputs", paymentInputs),
    effectiveFlowsHash: semanticHash("effective-flows", flowDigest),
    ...(legacySource ? { legacySource } : {}),
    effectiveFlowCount: flowDigest.length,
    effectiveFlowNetCents: safeInteger(flowDigest.reduce((sum, flow) => sum + flow.amountCents, 0), "effective flow net"),
    periods,
    totals: {
      grossPnlCents,
      managementFeeCents,
      carryCents,
      totalFeeCents,
      netPnlCents,
      grossTwrPpm,
      investorDietzPpm,
      dietzDenominatorCents,
      spanDays: inclusiveDays(econ.settings.start, finalAsOf)
    },
    balance: {
      accruedCents: totalFeeCents,
      paidCents,
      dueCents: safeInteger(totalFeeCents - paidCents, "amount due")
    },
    status: {
      valid: true,
      provisional: provisionalCodes.length > 0,
      provisionalCodes
    }
  };
  return { ...body, receiptId: semanticHash("calculation-receipt", body) };
}

export const sameFeeCalculationReceipt = (left, right) => canonicalJson(left) === canonicalJson(right);

const ROOT_KEYS = [
  "schema", "engineVersion", "asOf", "start", "accountIds", "managementRatePpm", "carryRatePpm",
  "dataInputsHash", "econInputsHash", "paymentInputsHash", "effectiveFlowsHash", "effectiveFlowCount",
  "effectiveFlowNetCents", "periods", "totals", "balance", "status", "receiptId"
];
const LEGACY_SOURCE_KEYS = ["policyId", "sourceEnvelopeSha256", "sourcePayloadSha256"];
const PERIOD_KEYS = [
  "ym", "from", "to", "state", "openingCents", "closingCents", "flowNetCents", "grossPnlCents",
  "feeBaseSumCents", "averageFeeBaseCents", "managementFeeCents", "carryCents", "totalFeeCents",
  "dietzDenominatorCents", "grossTwrPpm", "investorDietzPpm", "feeBasisDayCount", "calendarDayCount",
  "mgmtValid", "cumulativePnlBeforeCents", "cumulativePnlAfterCents", "highWaterBeforeCents",
  "highWaterAfterCents"
];
const TOTAL_KEYS = [
  "grossPnlCents", "managementFeeCents", "carryCents", "totalFeeCents", "netPnlCents", "grossTwrPpm",
  "investorDietzPpm", "dietzDenominatorCents", "spanDays"
];
const BALANCE_KEYS = ["accruedCents", "paidCents", "dueCents"];
const STATUS_KEYS = ["valid", "provisional", "provisionalCodes"];

const exactKeys = (value, keys, label, errors) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} is not an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  const matches = canonicalJson(actual) === canonicalJson(expected);
  if (!matches) errors.push(`${label} fields are not exact`);
  return matches;
};

const integerField = (value, label, errors, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${label} is not a valid integer`);
    return false;
  }
  return true;
};

const sameArray = (left, right) => canonicalJson(left) === canonicalJson(right);

function validateFeeCalculationReceiptUnsafe(receipt, data) {
  const errors = [];
  const legacy = receipt?.schema === FEE_LEGACY_RECEIPT_SCHEMA;
  if (!exactKeys(receipt, legacy ? [...ROOT_KEYS, "legacySource"] : ROOT_KEYS, "receipt", errors)) {
    return { ok: false, errors };
  }
  if (receipt.schema !== FEE_RECEIPT_SCHEMA && !legacy) errors.push("receipt schema is unsupported");
  if (receipt.engineVersion !== FEE_ENGINE_VERSION) errors.push("receipt engine version is unsupported");
  if (legacy && exactKeys(receipt.legacySource, LEGACY_SOURCE_KEYS, "legacy source", errors)) {
    if (receipt.legacySource.policyId !== legacyPolicy.LEGACY_POLICY_ID) {
      errors.push("legacy source policy is unsupported");
    }
    for (const field of ["sourceEnvelopeSha256", "sourcePayloadSha256"]) {
      if (typeof receipt.legacySource[field] !== "string" || !HASH_RE.test(receipt.legacySource[field])) {
        errors.push("legacy source commitment is invalid");
      }
    }
  }
  const dateRangeValid = isCalendarDate(receipt.start) && isCalendarDate(receipt.asOf) && receipt.asOf >= receipt.start;
  if (!dateRangeValid) {
    errors.push("receipt date range is invalid");
  }
  if (!Array.isArray(receipt.accountIds) || !receipt.accountIds.length
      || receipt.accountIds.some(id => typeof id !== "string" || id === "")
      || new Set(receipt.accountIds).size !== receipt.accountIds.length
      || !sameArray(receipt.accountIds, ACCOUNT_IDS)) {
    errors.push("receipt account ids are invalid");
  }
  integerField(receipt.managementRatePpm, "management rate", errors, { min: 0, max: RATE_MAX_PPM });
  integerField(receipt.carryRatePpm, "carry rate", errors, { min: 0, max: RATE_MAX_PPM });
  for (const field of ["dataInputsHash", "econInputsHash", "paymentInputsHash", "effectiveFlowsHash"]) {
    if (!HASH_RE.test(String(receipt[field] || ""))) errors.push(`${field} is invalid`);
  }
  integerField(receipt.effectiveFlowCount, "effective flow count", errors, { min: 0 });
  integerField(receipt.effectiveFlowNetCents, "effective flow net", errors);

  if (!Array.isArray(receipt.periods) || !receipt.periods.length) errors.push("receipt periods are missing");
  else {
    let expectedFrom = receipt.start;
    let priorClosing = null;
    let cumulative = 0;
    let highWater = 0;
    for (const [index, period] of receipt.periods.entries()) {
      const label = `period #${index + 1}`;
      if (!exactKeys(period, PERIOD_KEYS, label, errors)) continue;
      if (!dateRangeValid) continue;
      const ym = expectedFrom.slice(0, 7);
      const expectedTo = ym === receipt.asOf.slice(0, 7) ? receipt.asOf : endOfMonth(ym);
      const expectedState = expectedTo === receipt.asOf && receipt.asOf < endOfMonth(ym) ? "in-progress" : "complete";
      if (period.ym !== ym || period.from !== expectedFrom || period.to !== expectedTo || period.state !== expectedState) {
        errors.push(`${label} does not match the continuous month range`);
      }
      const days = isCalendarDate(period.from) && isCalendarDate(period.to) ? inclusiveDays(period.from, period.to) : -1;
      const integerKeys = [
        "openingCents", "closingCents", "flowNetCents", "grossPnlCents", "feeBaseSumCents",
        "averageFeeBaseCents", "managementFeeCents", "carryCents", "totalFeeCents",
        "dietzDenominatorCents", "grossTwrPpm", "investorDietzPpm", "feeBasisDayCount",
        "calendarDayCount", "cumulativePnlBeforeCents", "cumulativePnlAfterCents",
        "highWaterBeforeCents", "highWaterAfterCents"
      ];
      const integersValid = integerKeys.map(key => integerField(period[key], `${label}.${key}`, errors)).every(Boolean);
      if (!integersValid || !Number.isSafeInteger(receipt.managementRatePpm)
          || !Number.isSafeInteger(receipt.carryRatePpm)) {
        expectedFrom = addDay(expectedTo);
        continue;
      }
      if (!(period.openingCents > 0) || !(period.closingCents > 0) || period.feeBaseSumCents < 0
          || period.averageFeeBaseCents < 0 || period.managementFeeCents < 0 || period.carryCents < 0
          || period.totalFeeCents < 0 || !(period.dietzDenominatorCents > 0) || period.grossTwrPpm <= -1_000_000) {
        errors.push(`${label} has an out-of-range value`);
      }
      if (period.mgmtValid !== true || period.feeBasisDayCount !== days || period.calendarDayCount !== days) {
        errors.push(`${label} has an invalid management-fee day count`);
      }
      if (priorClosing !== null && period.openingCents !== priorClosing) errors.push(`${label} opening does not chain`);
      if (period.grossPnlCents !== period.closingCents - period.openingCents - period.flowNetCents) {
        errors.push(`${label} P&L identity does not balance`);
      }
      if (period.averageFeeBaseCents !== Math.round(period.feeBaseSumCents / period.calendarDayCount)) {
        errors.push(`${label} average fee base does not balance`);
      }
      if (period.managementFeeCents !== applyPpm(period.feeBaseSumCents, receipt.managementRatePpm, 365)) {
        errors.push(`${label} management fee does not match its basis`);
      }
      if (period.cumulativePnlBeforeCents !== cumulative || period.highWaterBeforeCents !== highWater) {
        errors.push(`${label} High-water mark chain is broken`);
      }
      cumulative += period.grossPnlCents;
      const expectedCarry = applyPpm(Math.max(0, cumulative - highWater), receipt.carryRatePpm);
      highWater = Math.max(highWater, cumulative);
      if (period.cumulativePnlAfterCents !== cumulative || period.highWaterAfterCents !== highWater
          || period.carryCents !== expectedCarry) errors.push(`${label} Carry or High-water mark is inconsistent`);
      if (period.totalFeeCents !== period.managementFeeCents + period.carryCents) {
        errors.push(`${label} fee components do not add up`);
      }
      if (period.investorDietzPpm !== Math.round(
        ((period.grossPnlCents - period.totalFeeCents) / period.dietzDenominatorCents) * 1_000_000
      )) errors.push(`${label} investor Dietz does not match its inputs`);
      expectedFrom = addDay(expectedTo);
      priorClosing = period.closingCents;
    }
    if (receipt.periods.at(-1)?.to !== receipt.asOf) errors.push("receipt periods do not reach asOf");
    if (receipt.periods.reduce((sum, period) => sum + period.flowNetCents, 0) !== receipt.effectiveFlowNetCents) {
      errors.push("receipt flow total does not match its periods");
    }
  }

  if (exactKeys(receipt.totals, TOTAL_KEYS, "receipt totals", errors)) {
    for (const key of TOTAL_KEYS) integerField(receipt.totals[key], `totals.${key}`, errors);
    if (!(receipt.totals.dietzDenominatorCents > 0) || !(receipt.totals.spanDays > 0)) {
      errors.push("receipt total denominator or span is invalid");
    }
    if (Array.isArray(receipt.periods)) {
      const sum = key => receipt.periods.reduce((total, period) => total + period[key], 0);
      if (receipt.totals.grossPnlCents !== sum("grossPnlCents")
          || receipt.totals.managementFeeCents !== sum("managementFeeCents")
          || receipt.totals.carryCents !== sum("carryCents")) errors.push("receipt totals do not equal period sums");
      if (receipt.totals.totalFeeCents !== receipt.totals.managementFeeCents + receipt.totals.carryCents
          || receipt.totals.netPnlCents !== receipt.totals.grossPnlCents - receipt.totals.totalFeeCents) {
        errors.push("receipt total fee or net P&L identity is broken");
      }
      const expectedGrossTwr = Math.round((receipt.periods.reduce(
        (index, period) => index * (1 + period.grossTwrPpm / 1_000_000), 1
      ) - 1) * 1_000_000);
      if (receipt.totals.grossTwrPpm !== expectedGrossTwr) errors.push("receipt total gross TWR is inconsistent");
    }
    if (receipt.totals.investorDietzPpm !== Math.round(
      (receipt.totals.netPnlCents / receipt.totals.dietzDenominatorCents) * 1_000_000
    )) errors.push("receipt total investor Dietz is inconsistent");
    if (isCalendarDate(receipt.start) && isCalendarDate(receipt.asOf)
        && receipt.totals.spanDays !== inclusiveDays(receipt.start, receipt.asOf)) {
      errors.push("receipt total span is inconsistent");
    }
  }

  if (exactKeys(receipt.balance, BALANCE_KEYS, "receipt balance", errors)) {
    for (const key of BALANCE_KEYS) integerField(receipt.balance[key], `balance.${key}`, errors);
    if (receipt.balance.accruedCents !== receipt.totals?.totalFeeCents
        || receipt.balance.dueCents !== receipt.balance.accruedCents - receipt.balance.paidCents) {
      errors.push("receipt balance identity is broken");
    }
  }

  if (exactKeys(receipt.status, STATUS_KEYS, "receipt status", errors)) {
    if (receipt.status.valid !== true || typeof receipt.status.provisional !== "boolean"
        || !Array.isArray(receipt.status.provisionalCodes)
        || receipt.status.provisionalCodes.some(code => !ALLOWED_PROVISIONAL_CODES.has(code))
        || new Set(receipt.status.provisionalCodes).size !== receipt.status.provisionalCodes.length
        || receipt.status.provisional !== (receipt.status.provisionalCodes.length > 0)) {
      errors.push("receipt status is invalid");
    }
  }

  if (HASH_RE.test(String(receipt.receiptId || ""))) {
    const { receiptId, ...body } = receipt;
    if (semanticHash("calculation-receipt", body) !== receiptId) errors.push("receipt id does not match its contents");
  } else errors.push("receipt id is invalid");

  if (!errors.length) {
    try {
      if (latestDailyDate(data) !== receipt.asOf) throw new Error("receipt is not bound to the latest daily valuation");
      const normalizedData = normalizeDataInputs(data, {
        start: receipt.start,
        asOf: receipt.asOf,
        accountIds: receipt.accountIds
      });
      if (normalizedData.status.unresolvedCount > 0) throw new Error("unresolved flows make the receipt non-authoritative");
      if (semanticHash("public-calculation-inputs", normalizedData) !== receipt.dataInputsHash) {
        errors.push("receipt no longer matches public inputs");
      }
      if (!sameArray(receipt.status.provisionalCodes, provisionalCodesFor(normalizedData))) {
        errors.push("receipt provisional status no longer matches public inputs");
      }
    } catch (error) {
      errors.push(`receipt data binding failed: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// This validator is a trust boundary used by both the writer and the read-only
// reporter. Malformed JSON must be rejected as data, never escape as an
// exception that can crash a scheduled run or expose a stack trace.
export function validateFeeCalculationReceipt(receipt, data) {
  try {
    return validateFeeCalculationReceiptUnsafe(receipt, data);
  } catch {
    return { ok: false, errors: ["receipt validation failed safely"] };
  }
}

export function validateFeeCalculationReceiptWithEcon(receipt, data, economicInput) {
  const publicValidation = validateFeeCalculationReceipt(receipt, data);
  if (!publicValidation.ok) return publicValidation;
  try {
    const expected = buildFeeCalculationReceipt({ data, economicInput, asOf: receipt.asOf });
    if (!sameFeeCalculationReceipt(receipt, expected)) {
      return { ok: false, errors: ["receipt no longer matches private economic inputs"] };
    }
  } catch (error) {
    return { ok: false, errors: [`receipt private-input validation failed: ${error.message}`] };
  }
  return { ok: true, errors: [] };
}
