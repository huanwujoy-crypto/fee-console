#!/usr/bin/env node

// A public, amount-free receipt for the daily fee-console producer.
// It records that the trusted writer actually ran and distinguishes a verified
// no-op from a data update.  It never replaces data.json or the private fee
// receipt; successful receipts are emitted only after both have been checked.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateFeeCalculationReceiptWithEcon } from "./fee-receipt-core.mjs";

export const HEALTH_SCHEMA = "fee-console.daily-health.v1";
export const SUCCESS_OUTCOMES = Object.freeze(["updated", "no-op"]);
export const FAILURE_CODES = Object.freeze([
  "AUTH_CONFIG",
  "BENCHMARK_SOURCE",
  "ECON_SOURCE",
  "RECEIPT_INVALID",
  "RUN_FAILED",
  "SHARESIGHT_SOURCE",
  "SHARESIGHT_UNSTABLE",
  "STYLE_UNRESOLVED",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const EXACT_KEYS = ["schema", "checkedAt", "targetDate", "sourceDates", "outcome", "dataSha256", "errorCode"];
const SOURCE_KEYS = ["schwab", "webull", "benchmark"];
const DAY_MS = 86_400_000;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const isDate = value => {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function validateHealth(value, { now = new Date(), maxAgeHours = 36 } = {}) {
  const errors = [];
  if (!exactKeys(value, EXACT_KEYS)) return ["health receipt shape"];
  if (value.schema !== HEALTH_SCHEMA) errors.push("health receipt schema");
  if (typeof value.checkedAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.checkedAt)
      || !Number.isFinite(Date.parse(value.checkedAt))) errors.push("health receipt time");
  else {
    const age = now.getTime() - Date.parse(value.checkedAt);
    if (age < -300_000 || age > maxAgeHours * 3_600_000) errors.push("health receipt age");
  }
  if (!isDate(value.targetDate)) errors.push("health target date");
  if (!exactKeys(value.sourceDates, SOURCE_KEYS)) errors.push("health source dates");
  else if (isDate(value.targetDate)) {
    for (const key of SOURCE_KEYS) {
      const source = value.sourceDates[key];
      if (source !== null && !isDate(source)) errors.push(`health ${key} source date`);
      else if (source !== null) {
        const lag = dayDiff(source, value.targetDate);
        if (lag < 0 || lag > 3) errors.push(`health ${key} source lag`);
      }
    }
  }
  if (![...SUCCESS_OUTCOMES, "failed"].includes(value.outcome)) errors.push("health outcome");
  if (typeof value.dataSha256 !== "string" || !SHA_RE.test(value.dataSha256)) errors.push("health data hash");
  if (value.outcome === "failed") {
    if (!FAILURE_CODES.includes(value.errorCode)) errors.push("health failure code");
  } else if (value.errorCode !== null) errors.push("successful health receipt has an error code");
  return errors;
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9-]*)=([\s\S]*)$/.exec(raw);
    if (!match || Object.hasOwn(args, match[1])) throw new Error("invalid or duplicate argument");
    args[match[1]] = match[2];
  }
  return args;
}

function keyBytes() {
  const raw = String(process.env.FEE_DATA_KEY || "").trim();
  if (!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(raw)) throw new Error("data key unavailable");
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("data key unavailable");
  return key;
}

function decryptEnvelope(bytes, version, key) {
  const outer = JSON.parse(bytes.toString("utf8"));
  if (!exactKeys(outer, ["enc", "v", "data"]) || outer.enc !== true || outer.v !== version
      || typeof outer.data !== "string") throw new Error("encrypted envelope invalid");
  const sealed = Buffer.from(outer.data, "base64");
  if (sealed.length < 29 || sealed.toString("base64") !== outer.data) throw new Error("encrypted envelope invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]).toString("utf8"));
}

function readStableOutsideRepo(file) {
  if (!path.isAbsolute(file)) throw new Error("private source unavailable");
  const target = fs.realpathSync(file);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(repo, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("private source unavailable");
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error("private source unavailable");
  const first = fs.readFileSync(target), second = fs.readFileSync(target);
  if (!first.equals(second)) throw new Error("private source changed");
  return first;
}

function writeAtomic(target, value) {
  const absolute = path.resolve(target), directory = path.dirname(absolute);
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(temporary, "wx", 0o644);
  try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, absolute); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}

export function buildHealth({ checkedAt, targetDate, sourceDates, outcome, dataSha256, errorCode = null }) {
  const health = { schema: HEALTH_SCHEMA, checkedAt, targetDate, sourceDates, outcome, dataSha256, errorCode };
  const errors = validateHealth(health);
  if (errors.length) throw new Error(errors[0]);
  return health;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2), args = parseArgs(rest);
  if (!new Set(["create-success", "create-failure", "validate"]).has(command)) throw new Error("unknown command");
  const allowed = command === "validate"
    ? new Set(["health", "data", "max-age-hours"])
    : new Set(["out", "data", "target-date", "source-schwab", "source-webull", "source-benchmark", "outcome", "error-code", "checked-at", "style-preflight"]);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error("unknown argument");

  if (command === "validate") {
    const health = JSON.parse(fs.readFileSync(args.health || "fee-data-health.json", "utf8"));
    const maxAgeHours = Number(args["max-age-hours"] || 36);
    if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 168) throw new Error("invalid maximum age");
    const errors = validateHealth(health, { maxAgeHours });
    const bytes = fs.readFileSync(args.data || "data.json");
    if (health.dataSha256 !== sha256(bytes)) errors.push("health data hash mismatch");
    if (errors.length) throw new Error(errors.join("; "));
    console.log(`health ok ${health.targetDate} ${health.outcome}`);
    return;
  }

  const dataPath = args.data || "data.json", dataBytes = fs.readFileSync(dataPath);
  const sourceDates = {
    schwab: args["source-schwab"] || null,
    webull: args["source-webull"] || null,
    benchmark: args["source-benchmark"] || null,
  };
  const checkedAt = args["checked-at"] || new Date().toISOString();
  if (command === "create-failure") {
    const health = buildHealth({ checkedAt, targetDate: args["target-date"], sourceDates,
      outcome: "failed", dataSha256: sha256(dataBytes), errorCode: args["error-code"] });
    writeAtomic(args.out || "fee-data-health.json", health);
    console.log(`health failed ${health.targetDate} ${health.errorCode}`);
    return;
  }

  if (!SUCCESS_OUTCOMES.includes(args.outcome) || args["style-preflight"] !== "pass") {
    throw new Error("successful run evidence unavailable");
  }
  const key = keyBytes();
  const data = decryptEnvelope(dataBytes, 3, key);
  const econPath = String(process.env.FEE_ECON_FILE || "").trim();
  const economicInput = decryptEnvelope(readStableOutsideRepo(econPath), 4, key);
  if (!object(economicInput) || economicInput.v !== 4) {
    throw new Error("economic input version invalid");
  }
  const receipt = data?.feeCalculationReceipt;
  const validation = validateFeeCalculationReceiptWithEcon(receipt, data, economicInput);
  if (!validation.ok || receipt?.asOf !== args["target-date"] || data?.daily?.at(-1)?.d !== args["target-date"]) {
    throw new Error("calculation receipt unavailable");
  }
  const latest = data.daily.at(-1);
  if (latest.bd !== undefined && sourceDates.benchmark !== latest.bd) throw new Error("benchmark source date mismatch");
  if (latest.bd === undefined && sourceDates.benchmark !== null) throw new Error("benchmark source date mismatch");
  const health = buildHealth({ checkedAt, targetDate: args["target-date"], sourceDates,
    outcome: args.outcome, dataSha256: sha256(dataBytes), errorCode: null });
  writeAtomic(args.out || "fee-data-health.json", health);
  console.log(`health ok ${health.targetDate} ${health.outcome}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("error: fee daily health validation failed"); process.exit(1); });
}
