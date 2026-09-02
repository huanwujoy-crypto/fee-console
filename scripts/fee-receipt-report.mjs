#!/usr/bin/env node
// Read-only consumer for the trusted fee calculation receipt.  It validates
// both the public daily ledger and the same locked private snapshot used by the
// writer, then emits only an explicit allowlist of derived scalar fields.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateFeeCalculationReceiptWithEcon } from "./fee-receipt-core.mjs";

const die = message => { console.error("error: " + message); process.exit(1); };
const MAX_ECON_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// Never risk printing portfolio amounts to a GitHub Actions log.  This gate is
// deliberately evaluated before arguments, secrets, or files are inspected.
if (/^(?:1|true)$/i.test(String(process.env.GITHUB_ACTIONS || "").trim())) {
  die("fee receipt reporting is refused in GitHub Actions; no fee figures emitted");
}

const argv = process.argv.slice(2);
if (argv.some(arg => arg === "--key" || arg.startsWith("--key="))) {
  die("--key is refused; use FEE_DATA_KEY");
}
const args = {};
for (const arg of argv) {
  const match = /^--([a-z][a-z0-9-]*)=([\s\S]*)$/.exec(arg);
  if (!match) die(`bad argument ${JSON.stringify(arg)} (expected --name=value)`);
  if (Object.hasOwn(args, match[1])) die(`duplicate --${match[1]}`);
  args[match[1]] = match[2];
}
for (const key of Object.keys(args)) if (!new Set(["file", "format"]).has(key)) die(`unknown argument --${key}`);
const file = args.file || "data.json";
const format = args.format || "json";
if (!new Set(["json", "markdown"]).has(format)) die("--format must be json or markdown");

const rawKey = String(process.env.FEE_DATA_KEY || "").trim();
if (!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(rawKey)) die("FEE_DATA_KEY is unavailable or invalid");
const key = Buffer.from(rawKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
if (key.length !== 32) die("FEE_DATA_KEY must decode to exactly 32 bytes");

const decrypt = (outer, expectedVersion, label) => {
  if (!outer || typeof outer !== "object" || Array.isArray(outer)
      || outer.enc !== true || outer.v !== expectedVersion || typeof outer.data !== "string") {
    throw new Error(`${label} must be an encrypted v${expectedVersion} envelope`);
  }
  const encrypted = Buffer.from(outer.data, "base64");
  if (encrypted.length < 29) throw new Error(`${label} ciphertext is too short`);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  return Buffer.concat([
    decipher.update(encrypted.subarray(12, encrypted.length - 16)),
    decipher.final()
  ]).toString("utf8");
};

let payload;
try {
  const outer = JSON.parse(fs.readFileSync(file, "utf8"));
  payload = JSON.parse(decrypt(outer, 3, "data file"));
} catch {
  die("data decrypt failed; no fee figures emitted");
}

const configuredEcon = String(process.env.FEE_ECON_FILE || "").trim();
if (!configuredEcon) die("FEE_ECON_FILE is unavailable; no fee figures emitted");
if (!path.isAbsolute(configuredEcon)) die("FEE_ECON_FILE must be an absolute path; no fee figures emitted");

let economicInput;
try {
  const target = fs.realpathSync(configuredEcon);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(repoRoot, target);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..")) {
    throw new Error("private snapshot is inside the repository");
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ECON_SNAPSHOT_BYTES) {
    throw new Error("private snapshot has an invalid size");
  }
  const first = fs.readFileSync(target);
  const second = fs.readFileSync(target);
  if (!first.equals(second)) throw new Error("private snapshot changed while reading");
  economicInput = JSON.parse(decrypt(JSON.parse(first.toString("utf8")), 4, "private snapshot"));
  if (!economicInput || typeof economicInput !== "object" || Array.isArray(economicInput) || economicInput.v !== 4) {
    throw new Error("private snapshot payload is unsupported");
  }
} catch {
  die("private snapshot validation failed; no fee figures emitted");
}

const receipt = payload?.feeCalculationReceipt;
let validation;
try {
  validation = validateFeeCalculationReceiptWithEcon(receipt, payload, economicInput);
} catch {
  die("calculation receipt validation failed safely; no fee figures emitted");
}
if (!validation.ok) die("calculation receipt is missing, stale, or unsupported; no fee figures emitted");

const pick = (source, keys) => Object.fromEntries(keys.map(key => [key, source[key]]));
const periodKeys = [
  "ym", "from", "to", "state", "openingCents", "closingCents", "flowNetCents", "grossPnlCents",
  "feeBaseSumCents", "averageFeeBaseCents", "managementFeeCents", "carryCents", "totalFeeCents",
  "dietzDenominatorCents", "grossTwrPpm", "investorDietzPpm", "feeBasisDayCount", "calendarDayCount",
  "mgmtValid", "cumulativePnlBeforeCents", "cumulativePnlAfterCents", "highWaterBeforeCents",
  "highWaterAfterCents"
];
const totalKeys = [
  "grossPnlCents", "managementFeeCents", "carryCents", "totalFeeCents", "netPnlCents",
  "grossTwrPpm", "investorDietzPpm", "dietzDenominatorCents", "spanDays"
];
const currentPeriod = pick(receipt.periods.at(-1), periodKeys);
const output = {
  schema: receipt.schema,
  engineVersion: receipt.engineVersion,
  asOf: receipt.asOf,
  receiptId: receipt.receiptId,
  status: {
    valid: receipt.status.valid,
    provisional: receipt.status.provisional,
    provisionalCodes: [...receipt.status.provisionalCodes]
  },
  currentPeriod,
  totals: pick(receipt.totals, totalKeys),
  balance: pick(receipt.balance, ["accruedCents", "paidCents", "dueCents"])
};

if (format === "json") {
  console.log(JSON.stringify(output));
} else {
  const money = amount => `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const percent = ppm => `${(ppm / 10_000).toFixed(2)}%`;
  console.log([
    `# Fee calculation receipt · ${receipt.asOf}`,
    "",
    `- Status: ${receipt.status.provisional ? "PROVISIONAL" : "VERIFIED"}`,
    `- Receipt: \`${receipt.receiptId.slice(0, 16)}…\` · ${receipt.engineVersion}`,
    `- Current management fee: ${money(currentPeriod.managementFeeCents)}`,
    `- Current Carry: ${money(currentPeriod.carryCents)}`,
    `- Current gross P&L: ${money(currentPeriod.grossPnlCents)}`,
    `- Cumulative net P&L: ${money(receipt.totals.netPnlCents)}`,
    `- Cumulative gross TWR: ${percent(receipt.totals.grossTwrPpm)}`,
    `- Investor Modified Dietz: ${percent(receipt.totals.investorDietzPpm)}`,
    `- Cumulative management fee: ${money(receipt.totals.managementFeeCents)}`,
    `- Cumulative Carry: ${money(receipt.totals.carryCents)}`,
    `- Paid: ${money(receipt.balance.paidCents)}`,
    `- Amount due: ${money(receipt.balance.dueCents)}`
  ].join("\n"));
}
