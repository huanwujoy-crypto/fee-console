#!/usr/bin/env node

// One-shot cloud producer. It writes only encrypted candidate files to a
// caller-owned private output directory; publication is a separate step.

import crypto from "node:crypto";
import {sealTradeLinks,openTradeLinks} from "./fee-runtime-evidence.mjs";
import { incomeDateEvidenceFromData } from './fee-income-date-policy.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode } from "./fee-economic-source.mjs";
import { latestCommonBenchmarkDate, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { isIsoDate, isWeekend } from "./daily-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const fail = code => { throw new Error(`FEE_CLOUD_${code}`); };
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function args(argv) {
  const result = {};
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9-]*)=([\s\S]+)$/.exec(raw);
    if (!match || Object.hasOwn(result, match[1])) fail("ARGUMENT");
    result[match[1]] = match[2];
  }
  if (Object.keys(result).some(key => !["benchmark-file", "out-dir", "target-date", "checked-at"].includes(key))) fail("ARGUMENT");
  return result;
}

function safeOutputDir(value) {
  if (!path.isAbsolute(value)) fail("OUTPUT_DIR");
  const resolved = fs.realpathSync(value), relative = path.relative(ROOT, resolved);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) fail("OUTPUT_DIR");
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fail("OUTPUT_DIR");
  return resolved;
}

function readJson(file, max = 5 * 1024 * 1024) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > max) fail("INPUT_FILE");
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail("INPUT_FILE"); }
}

// Return only fixed categories. Child stderr can contain private amounts,
// account identities or paths and must never be forwarded to Actions output.
export function writerFailureCode(stderr, preflight = false) {
  const text = String(stderr || "");
  const styleCodes = new Set(["ACCOUNT", "ACCOUNT_STOCK_SUM", "AMOUNT", "BEFORE_FIRST_HOLDING",
    "CLASSIFIED_AT", "DATE", "DIRECTORY_PERMISSIONS", "EFFECTIVE_FIRST_HOLDING", "ENTRY_ID",
    "EVIDENCE_REQUIRED", "FILE_ABSOLUTE", "FILE_CHANGED", "FILE_IN_REPO", "FILE_PERMISSIONS",
    "FILE_SIZE", "FUTURE_CLASSIFICATION", "HOLDINGS", "HOLDING_DUPLICATE", "IDENTITY",
    "INDEPENDENT_REVIEW", "INPUT_DATE", "PROPOSAL_DUPLICATE", "PROPOSAL_NOT_HELD", "REGISTRY",
    "REGISTRY_CAPACITY", "REGISTRY_DUPLICATE", "REGISTRY_IMMUTABLE", "SCHEMA", "SOURCE_DATE",
    "STATIC_CONFLICT", "STATIC_IMMUTABLE", "STATIC_LEARNED_CONFLICT", "STATIC_MAP", "STOCK_SUM",
    "STYLE", "TICKER_CONFLICT", "TOP_HOLDINGS", "INPUT_REQUIRED", "INPUT_INVALID", "MANUAL_TOTALS_REFUSED"]);
  const style = /^error: STYLE_([A-Z0-9_]+) — nothing written$/m.exec(text)?.[1];
  const categories = [
    [/^error: STYLE_[A-Z0-9_]+(?: — nothing written)?$/m, "STYLE"],
    [/^error: duplicate\/stale cash in /m, "CASH_RECONCILIATION"],
    [/^error: --acct-cash-.* are required:/m, "CASH_EVIDENCE"],
    [/^error: (?:schwab|webull) moved .*refusing an impossible amount/m, "ACCOUNT_MOVE"],
    [/^error: fee calculation receipt failed:/m, "FEE_RECEIPT"],
    [/^error: FEE_ECON_FILE /m, "ECONOMIC_INPUT"],
    [/^error: (?:private legacy source|current legacy economic input)/m, "ECONOMIC_SOURCE"],
    [/^error: flow /m, "FLOW"],
    [/^error: (?:split is impossible|growth\/value split is incomplete)/m, "SPLIT"],
    [/^error: --(?:date|src-|schwab|webull|cash|stock|other|spy|qqq)/m, "INPUT"],
  ];
  const category = styleCodes.has(style) ? `STYLE_${style}`
    : categories.find(([pattern]) => pattern.test(text))?.[1] || "UNKNOWN";
  return `FEE_CLOUD_WRITER_${preflight ? "PREFLIGHT_" : ""}${category}`;
}

function run(script, cli, env) {
  const result = spawnSync(NODE, [path.join(ROOT, "scripts", script), ...cli], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  if (result.status !== 0) {
    if (script === "daily.mjs") throw new Error(writerFailureCode(result.stderr, cli.includes("--style-preflight")));
    fail(script === "fee-receipt-report.mjs" ? "RECEIPT" : "HEALTH");
  }
  return String(result.stdout || "").trim();
}

export function verifyWriterOutcome(beforeHash, afterHash, output, targetDate, priorWrites = false) {
  const outcome = beforeHash === afterHash ? "no-op" : "updated";
  const accepted = outcome === "updated" && priorWrites ? "(?:ok|no-op)" : outcome === "updated" ? "ok" : "no-op";
  if (!new RegExp(`^(?:${accepted})\\s+${targetDate}\\b`).test(String(output || ""))) fail("WRITER_OUTCOME");
  return outcome;
}

const addDays = (date, count) => new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000)
  .toISOString().slice(0, 10);

export function weekendGapDates(points, targetDate) {
  if (!Array.isArray(points) || !isIsoDate(targetDate)) fail("WEEKEND_GAP");
  const latest = points.filter(point => point && isIsoDate(point.d) && point.d < targetDate)
    .sort((a, b) => a.d.localeCompare(b.d)).at(-1);
  if (!latest) return [];
  const gap = [];
  for (let date = addDays(latest.d, 1); date < targetDate; date = addDays(date, 1)) gap.push(date);
  if (gap.some(date => !isWeekend(date))) fail("WEEKEND_GAP");
  return gap;
}

function decryptCandidate(filename, keyText) {
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { fail("CANDIDATE"); }
  if (!envelope || envelope.enc !== true || envelope.v !== 3 || typeof envelope.data !== "string") fail("CANDIDATE");
  const key = Buffer.from(String(keyText || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const bytes = Buffer.from(envelope.data, "base64");
  if (key.length !== 32 || bytes.length < 29) fail("CANDIDATE");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8"));
  } catch { fail("CANDIDATE"); }
}

export function assertCandidateReceiptable(payload) {
  if (!payload || !Array.isArray(payload.flowsUnresolved)) fail("CANDIDATE");
  if (payload.flowsUnresolved.length > 0) fail("UNRESOLVED_FLOW");
}

const TRANSIENT_READ_FAILURES = new Set([
  "FEE_CLOUD_SOURCE_UNAVAILABLE",
  "FEE_CLOUD_SOURCE_UNSTABLE",
  "FEE_CLOUD_AUTH_UNAVAILABLE",
]);
const TRANSIENT_ECONOMIC_FAILURES = new Set([
  "SOURCE_NETWORK",
  "SOURCE_TIMEOUT",
  "SOURCE_CHANGED",
]);

export async function fetchEconomicWithRetry(fetchEconomic, options = {}) {
  const delayMs = options.delayMs ?? 15_000;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (typeof fetchEconomic !== "function" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) fail("CONFIG");
  try {
    return { economic: await fetchEconomic(), retryCount: 0 };
  } catch (error) {
    if (!(error instanceof SourceFetchError) || !TRANSIENT_ECONOMIC_FAILURES.has(sourceFailureCode(error))) throw error;
    await sleep(delayMs);
    return { economic: await fetchEconomic(), retryCount: 1 };
  }
}

export async function readStableWithRetry(reader, targetDate, benchmark, options = {}) {
  const delayMs = options.delayMs ?? 15_000;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!reader || typeof reader.readStable !== "function" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    fail("CONFIG");
  }
  try {
    return { input: await reader.readStable(targetDate, benchmark), retryCount: 0 };
  } catch (error) {
    if (!TRANSIENT_READ_FAILURES.has(String(error?.message))) throw error;
    await sleep(delayMs);
    return { input: await reader.readStable(targetDate, benchmark), retryCount: 1 };
  }
}

export function carryWeekendGap(dataFile, targetDate, env) {
  let payload = decryptCandidate(dataFile, env.FEE_DATA_KEY);
  const gap = weekendGapDates(payload.daily, targetDate);
  if (!gap.length) return 0;
  let prior = payload.daily.filter(point => point && isIsoDate(point.d) && point.d < targetDate)
    .sort((a, b) => a.d.localeCompare(b.d)).at(-1);
  const sourceDate = prior.d;
  for (const date of gap) {
    if (!["schwab", "webull", "cash", "stock", "other", "spy", "qqq"].every(key => Number.isFinite(prior[key]))
        || !isIsoDate(prior.bd)) fail("WEEKEND_GAP");
    const cli = [
      `--date=${date}`, `--file=${dataFile}`,
      `--schwab=${prior.schwab}`, `--webull=${prior.webull}`,
      `--src-schwab=${sourceDate}`, `--src-webull=${sourceDate}`,
      `--cash=${prior.cash}`, `--stock=${prior.stock}`, `--other=${prior.other}`,
      `--spy=${prior.spy}`, `--qqq=${prior.qqq}`, `--src-bench=${prior.bd}`,
      "--bench-state=closed", "--flows=[]", "--weekend-carry",
    ];
    if (typeof prior.sourceFetchedAt === "string" && typeof prior.sourceFingerprint === "string") {
      cli.push(`--source-fetched-at=${prior.sourceFetchedAt}`, `--source-fingerprint=${prior.sourceFingerprint}`);
    }
    const output = run("daily.mjs", cli, { ...env, FEE_STYLE_INPUT_FILE: "" });
    if (!new RegExp(`^(?:ok|no-op)\\s+${date}\\b`).test(output)) fail("WEEKEND_GAP");
    payload = decryptCandidate(dataFile, env.FEE_DATA_KEY);
    prior = payload.daily.find(point => point && point.d === date);
    if (!prior) fail("WEEKEND_GAP");
  }
  return gap.length;
}

function writerArgs(input, file) {
  const cli = [
    `--date=${input.targetDate}`, `--file=${file}`,
    `--schwab=${input.accounts.schwab}`, `--webull=${input.accounts.webull}`,
    `--src-schwab=${input.sourceDates.schwab}`, `--src-webull=${input.sourceDates.webull}`,
    `--cash=${input.splits.cash}`, `--stock=${input.splits.stock}`, `--other=${input.splits.other}`,
    `--spy=${input.benchmark.spy}`, `--qqq=${input.benchmark.qqq}`,
    `--spyd=${input.benchmark.spyd}`, `--qqqd=${input.benchmark.qqqd}`,
    `--src-bench=${input.benchmark.sourceDate}`, `--bench-state=${input.benchmark.state}`,
    `--flows=${JSON.stringify(input.flows)}`, `--source-fetched-at=${input.sourceFetchedAt}`,
    `--source-fingerprint=${input.sourceFingerprint}`,
  ];
  for (const account of ["schwab", "webull"]) if (Object.hasOwn(input.acctCash, account)) {
    cli.push(`--acct-cash-${account}=${input.acctCash[account]}`,
      `--prev-acct-cash-${account}=${input.prevAcctCash[account]}`);
  }
  return cli;
}

export async function produce(options = {}) {
  let stage = "CONFIG";
  try {
    const cli = options.cli || args(process.argv.slice(2));
    const benchmarkFile = path.resolve(cli["benchmark-file"] || "");
    const output = safeOutputDir(cli["out-dir"] || "");
    stage = "BENCHMARK";
    const cache = readJson(benchmarkFile, 3 * 1024 * 1024);
    const targetDate = cli["target-date"] || latestCommonBenchmarkDate(cache);
    const benchmark = selectBenchmark(cache, targetDate);
    const checkedAt = cli["checked-at"] || new Date().toISOString();
    stage = "READER_SETUP";
    const reader = options.reader || new SharesightCloudReader({
      clientId: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,
      clientSecret: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,
      incomeDateEvidence:incomeDateEvidenceFromData(decryptCandidate(path.join(ROOT,"data.json"),process.env.FEE_DATA_KEY),targetDate),
    });
    let economic;
    const styleFile = path.join(output, "style-input.json");
    const dataFile = path.join(output, "data.json");
    const healthFile = path.join(output, "fee-data-health.json");
    try {
      stage = "ECONOMIC_READ";
      const economicRead = await fetchEconomicWithRetry(options.fetchEconomic || (() => fetchEconomicSnapshot()), options.retry);
      economic = economicRead.economic;
      if (economic.envelopeVersion !== 4) fail("ECON_VERSION");
      stage = "SOURCE_READ";
      const stableRead = await readStableWithRetry(reader, targetDate, benchmark, options.retry);
      const input = stableRead.input;
      input.sourceFetchedAt = checkedAt;
      stage = "PREPARE";
      fs.writeFileSync(styleFile, `${JSON.stringify(input.styleInput)}\n`, { mode: 0o600, flag: "wx" });
      const managementFile = path.join(output, 'management-input.json');
      if (input.managementInput) fs.writeFileSync(managementFile, JSON.stringify(input.managementInput), {mode:0o600,flag:'wx'});
      fs.copyFileSync(path.join(ROOT, "data.json"), dataFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dataFile, 0o600);
      const env = { ...process.env, FEE_ECON_FILE: economic.sourcePath, FEE_STYLE_INPUT_FILE: styleFile, FEE_MANAGEMENT_INPUT_FILE: input.managementInput ? managementFile : '' };
      const original = sha256(fs.readFileSync(dataFile));
      stage = "WEEKEND_CARRY";
      const weekendCarries = carryWeekendGap(dataFile, input.targetDate, env);
      const baseArgs = writerArgs(input, dataFile);
      stage = "STYLE_PREFLIGHT";
      run("daily.mjs", [...baseArgs, "--style-preflight"], env);
      stage = "WRITER";
      const writer = run("daily.mjs", baseArgs, env);
      const after = sha256(fs.readFileSync(dataFile));
      const outcome = verifyWriterOutcome(original, after, writer, targetDate, weekendCarries > 0);
      stage = "RECEIPT";
      assertCandidateReceiptable(decryptCandidate(dataFile, process.env.FEE_DATA_KEY));
      run("fee-receipt-report.mjs", [`--file=${dataFile}`, "--format=validate"], env);
      stage = "HEALTH_CREATE";
      run("fee-data-health.mjs", ["create-success", `--out=${healthFile}`, `--data=${dataFile}`,
        `--target-date=${targetDate}`, `--source-schwab=${input.sourceDates.schwab}`,
        `--source-webull=${input.sourceDates.webull}`, `--source-benchmark=${input.benchmark.sourceDate}`,
        `--outcome=${outcome}`, "--style-preflight=pass", `--checked-at=${checkedAt}`], env);
      stage = "ECONOMIC_RECHECK";
      await economic.checkCurrent();
      stage = "ASSOCIATION_RECEIPT";
      if(input.tradeLinkReceipts?.length){
        const health=readJson(healthFile),key=Buffer.from(String(process.env.FEE_DATA_KEY||""),"base64url");
        health.tradeLinkBinding=sealTradeLinks(input.tradeLinkReceipts,{targetDate,dataSha256:after},key);
        const restored=openTradeLinks(health.tradeLinkBinding,{targetDate,dataSha256:after},key);
        if(JSON.stringify(restored)!==JSON.stringify(input.tradeLinkReceipts))fail("ASSOCIATION_RECEIPT");
        fs.writeFileSync(healthFile,JSON.stringify(health)+"\n",{mode:0o600});
      }
      stage = "HEALTH_VALIDATE";
      run("fee-data-health.mjs", ["validate", `--health=${healthFile}`, `--data=${dataFile}`], env);
      return { targetDate, outcome, retryCount: economicRead.retryCount + stableRead.retryCount, dataSha256: after, sourceDates: {
        schwab: input.sourceDates.schwab, webull: input.sourceDates.webull, benchmark: input.benchmark.sourceDate,
      }, dataFile, healthFile };
    } finally {
      try { fs.unlinkSync(styleFile); } catch { /* best effort */ }
      try { fs.unlinkSync(path.join(output, "management-input.json")); } catch { /* best effort */ }
      try { economic?.cleanup(); } catch (error) {
        throw new Error(producerFailureCode(error, "CLEANUP"));
      }
    }
  } catch (error) {
    throw new Error(producerFailureCode(error, stage));
  }
}

// Only fixed program stages and exception categories may enter public diagnostics.
const DIAGNOSTIC_STAGES = new Set(['CONFIG', 'BENCHMARK', 'READER_SETUP', 'ECONOMIC_READ',
  'SOURCE_READ', 'PREPARE', 'WEEKEND_CARRY', 'STYLE_PREFLIGHT', 'WRITER', 'RECEIPT',
  'HEALTH_CREATE', 'ECONOMIC_RECHECK', 'ASSOCIATION_RECEIPT', 'HEALTH_VALIDATE', 'CLEANUP']);
const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EMFILE', 'EIO']);
export function producerFailureCode(error, stage) {
  if (error instanceof SourceFetchError) return sourceFailureCode(error);
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^FEE_CLOUD_[A-Z0-9_]{1,80}$/.test(message)) return message;
  const category = error instanceof TypeError ? 'TYPE' : error instanceof RangeError ? 'RANGE'
    : error instanceof SyntaxError ? 'SYNTAX' : error instanceof ReferenceError ? 'REFERENCE'
    : SYSTEM_CODES.has(error?.code) ? `SYSTEM_${error.code}` : 'UNKNOWN';
  return `FEE_CLOUD_STAGE_${DIAGNOSTIC_STAGES.has(stage) ? stage : 'UNKNOWN'}_${category}`;
}

async function main() {
  const result = await produce();
  console.log(JSON.stringify({ schema: "fee-console.cloud-producer.v1", targetDate: result.targetDate,
    outcome: result.outcome, retryCount: result.retryCount, sourceDates: result.sourceDates, dataSha256: result.dataSha256 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    const code = producerFailureCode(error, "UNKNOWN");
    console.error(code);
    process.exitCode = 1;
  });
}
