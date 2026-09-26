#!/usr/bin/env node

// One-shot cloud producer. It writes only encrypted candidate files to a
// caller-owned private output directory; publication is a separate step.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode } from "./fee-economic-source.mjs";
import { latestCommonBenchmarkDate, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";

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

function run(script, cli, env) {
  const result = spawnSync(NODE, [path.join(ROOT, "scripts", script), ...cli], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  if (result.status !== 0) fail(script === "daily.mjs" ? "WRITER"
    : script === "fee-receipt-report.mjs" ? "RECEIPT" : "HEALTH");
  return String(result.stdout || "").trim();
}

export function verifyWriterOutcome(beforeHash, afterHash, output, targetDate) {
  const outcome = beforeHash === afterHash ? "no-op" : "updated";
  const prefix = outcome === "updated" ? "ok" : "no-op";
  if (!new RegExp(`^${prefix}\\s+${targetDate}\\b`).test(String(output || ""))) fail("WRITER_OUTCOME");
  return outcome;
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
  const cli = options.cli || args(process.argv.slice(2));
  const benchmarkFile = path.resolve(cli["benchmark-file"] || "");
  const output = safeOutputDir(cli["out-dir"] || "");
  const cache = readJson(benchmarkFile, 3 * 1024 * 1024);
  const targetDate = cli["target-date"] || latestCommonBenchmarkDate(cache);
  const benchmark = selectBenchmark(cache, targetDate);
  const checkedAt = cli["checked-at"] || new Date().toISOString();
  const reader = options.reader || new SharesightCloudReader({
    clientId: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,
    clientSecret: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,
  });
  let economic;
  const styleFile = path.join(output, "style-input.json");
  const dataFile = path.join(output, "data.json");
  const healthFile = path.join(output, "fee-data-health.json");
  try {
    economic = options.fetchEconomic ? await options.fetchEconomic() : await fetchEconomicSnapshot();
    if (economic.envelopeVersion !== 4) fail("ECON_VERSION");
    const input = await reader.readStable(targetDate, benchmark);
    input.sourceFetchedAt = checkedAt;
    fs.writeFileSync(styleFile, `${JSON.stringify(input.styleInput)}\n`, { mode: 0o600, flag: "wx" });
    fs.copyFileSync(path.join(ROOT, "data.json"), dataFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dataFile, 0o600);
    const env = { ...process.env, FEE_ECON_FILE: economic.sourcePath, FEE_STYLE_INPUT_FILE: styleFile };
    const baseArgs = writerArgs(input, dataFile);
    run("daily.mjs", [...baseArgs, "--style-preflight"], env);
    const before = sha256(fs.readFileSync(dataFile));
    const writer = run("daily.mjs", baseArgs, env);
    const after = sha256(fs.readFileSync(dataFile));
    const outcome = verifyWriterOutcome(before, after, writer, targetDate);
    run("fee-receipt-report.mjs", [`--file=${dataFile}`, "--format=validate"], env);
    run("fee-data-health.mjs", ["create-success", `--out=${healthFile}`, `--data=${dataFile}`,
      `--target-date=${targetDate}`, `--source-schwab=${input.sourceDates.schwab}`,
      `--source-webull=${input.sourceDates.webull}`, `--source-benchmark=${input.benchmark.sourceDate}`,
      `--outcome=${outcome}`, "--style-preflight=pass", `--checked-at=${checkedAt}`], env);
    await economic.checkCurrent();
    run("fee-data-health.mjs", ["validate", `--health=${healthFile}`, `--data=${dataFile}`], env);
    return { targetDate, outcome, dataSha256: after, sourceDates: {
      schwab: input.sourceDates.schwab, webull: input.sourceDates.webull, benchmark: input.benchmark.sourceDate,
    }, dataFile, healthFile };
  } finally {
    try { fs.unlinkSync(styleFile); } catch { /* best effort */ }
    economic?.cleanup();
  }
}

async function main() {
  const result = await produce();
  console.log(JSON.stringify({ schema: "fee-console.cloud-producer.v1", targetDate: result.targetDate,
    outcome: result.outcome, sourceDates: result.sourceDates, dataSha256: result.dataSha256 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    const code = error instanceof SourceFetchError ? sourceFailureCode(error)
      : /^FEE_CLOUD_[A-Z0-9_]+$/.test(String(error?.message)) ? error.message : "FEE_CLOUD_FAILED";
    console.error(code);
    process.exitCode = 1;
  });
}
