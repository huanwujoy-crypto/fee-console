#!/usr/bin/env node

// One-shot cloud producer. It writes only encrypted candidate files to a
// caller-owned private output directory; publication is a separate step.

import crypto from "node:crypto";
import { incomeDateEvidenceFromData, incomeDatePolicy } from './fee-income-date-policy.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode } from "./fee-economic-source.mjs";
import { latestCommonBenchmarkDate, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { isIsoDate, isWeekend } from "./daily-core.mjs";
import { validateHealth } from "./fee-data-health.mjs";

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
  if (Object.keys(result).some(key => !["mode", "benchmark-file", "out-dir", "target-date", "checked-at", "income-date-evidence-file"].includes(key))) fail("ARGUMENT");
  if (result.mode !== undefined && result.mode !== "published-preflight") fail("ARGUMENT");
  return result;
}

const PUBLIC_REPO = "huanwujoy-crypto/fee-console";
const OID_RE = /^[a-f0-9]{40}$/;

// Only a stable, already promoted main receipt can suppress a fresh read. A
// successful producer or candidate validation alone is never publication proof.
export function isPublishedTarget({ mainSha, finalMainSha, health, data }, targetDate, now = new Date()) {
  try {
    if (!OID_RE.test(mainSha || "") || mainSha !== finalMainSha || !Buffer.isBuffer(data)
        || !data.length || data.length >= 2 * 1024 * 1024 || !isIsoDate(targetDate)
        || validateHealth(health, { now }).length || health.targetDate !== targetDate
        || !["updated", "no-op"].includes(health.outcome) || health.dataSha256 !== sha256(data)
        || !["schwab", "webull", "benchmark"].every(key => health.sourceDates[key] === targetDate)) return false;
    const outer = JSON.parse(data.toString("utf8"));
    return Object.keys(outer).sort().join(",") === "data,enc,v" && outer.enc === true && outer.v === 3
      && typeof outer.data === "string" && outer.data.length >= 40
      && /^[A-Za-z0-9+/]+={0,2}$/.test(outer.data)
      && Buffer.from(outer.data, "base64").toString("base64") === outer.data;
  } catch { return false; }
}

// Keep the run-start boundary fixed while waiting. The current/later producer
// queue must never become a dependency of this single-concurrency producer.
export function isEarlierCandidate(commit, branch, mainSha, targetDate, startedAt) {
  if (!isIsoDate(targetDate)) return false;
  const time = Date.parse(commit?.commit?.committer?.date);
  const cutoff = Date.parse(startedAt);
  return new RegExp(`^codex/fee-daily-${targetDate.replaceAll("-", "")}-[a-z0-9]{6}$`).test(branch)
    && OID_RE.test(commit?.sha || "") && commit?.parents?.length === 1 && commit.parents[0].sha === mainSha
    && commit?.commit?.message === `daily ${targetDate}` && commit?.commit?.verification?.verified === true
    && commit?.author?.login === "huanwujoy-crypto"
    && ["huanwujoy-crypto", "web-flow"].includes(commit?.committer?.login)
    && Number.isFinite(time) && Number.isFinite(cutoff) && time <= cutoff && time >= cutoff - 36 * 3_600_000
    && Array.isArray(commit.files) && commit.files.length >= 1 && commit.files.length <= 2
    && commit.files.some(file => file.filename === "fee-data-health.json")
    && commit.files.every(file => file.status === "modified" && ["data.json", "fee-data-health.json"].includes(file.filename));
}

async function publicationRequest(route, signal) {
  const url = `https://api.github.com/repos/${PUBLIC_REPO}/${route}`;
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  // Actions metadata is public; contents:read must not require a new Actions
  // permission just to observe an earlier candidate's validator.
  if (token && !route.startsWith("actions/")) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(url, { headers, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); }
  catch { fail("PUBLICATION_READ"); }
  if (response.status !== 200 || response.url !== url) fail("PUBLICATION_READ");
  const bytes = await response.text();
  if (bytes.length > 8 * 1024 * 1024) fail("PUBLICATION_READ");
  try { return JSON.parse(bytes); } catch { fail("PUBLICATION_READ"); }
}

export async function readPublicationState(targetDate, startedAt, request = publicationRequest) {
  if (!isIsoDate(targetDate) || !Number.isFinite(Date.parse(startedAt))) fail("CONFIG");
  const ref = () => request("git/ref/heads/main");
  const mainSha = (await ref())?.object?.sha;
  if (!OID_RE.test(mainSha || "")) fail("PUBLICATION_READ");
  const file = async (name, max) => {
    const content = await request(`contents/${name}?ref=${mainSha}`);
    if (content?.type !== "file" || content?.encoding !== "base64" || !Number.isInteger(content.size)
        || content.size <= 0 || content.size > max || typeof content.content !== "string") fail("PUBLICATION_READ");
    const encoded = content.content.replaceAll("\n", "");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== content.size || bytes.toString("base64") !== encoded) fail("PUBLICATION_READ");
    return bytes;
  };
  const [healthBytes, data] = await Promise.all([file("fee-data-health.json", 64 * 1024), file("data.json", 2 * 1024 * 1024 - 1)]);
  let health;
  try { health = JSON.parse(healthBytes); } catch { health = null; }
  const finalMainSha = (await ref())?.object?.sha;
  const state = { mainSha, finalMainSha, health, data, pending: false };
  if (mainSha !== finalMainSha || isPublishedTarget(state, targetDate)) return state;
  const prefix = `codex/fee-daily-${targetDate.replaceAll("-", "")}-`;
  const refs = await request(`git/matching-refs/heads/${prefix}`);
  if (!Array.isArray(refs) || refs.length > 32) fail("PUBLICATION_READ");
  for (const candidate of refs) {
    const oid = candidate?.object?.sha;
    const branch = String(candidate?.ref || "").replace(/^refs\/heads\//, "");
    if (!OID_RE.test(oid || "") || !new RegExp(`^${prefix}[a-z0-9]{6}$`).test(branch) || oid === mainSha) continue;
    const commit = await request(`commits/${oid}`);
    if (!isEarlierCandidate(commit, branch, mainSha, targetDate, startedAt)) continue;
    state.pending = true;
    let listing;
    try { listing = await request(`actions/workflows/validate-fee-data.yml/runs?branch=${encodeURIComponent(branch)}&per_page=5`); }
    catch { continue; } // known candidate remains pending even if metadata is unavailable
    if (!Array.isArray(listing?.workflow_runs)) continue;
    const runs = listing.workflow_runs.filter(run => run.head_sha === oid && run.head_branch === branch && run.event === "push")
      .sort((a, b) => Number(b.id) - Number(a.id));
    const latest = runs[0];
    // A new candidate may precede its validator wake-up. A successful validator
    // may precede promotion. In both cases wait for main, never create a twin.
    if (latest?.status === "completed" && latest.conclusion !== "success") fail("PUBLICATION_CANDIDATE_FAILED");
  }
  state.finalMainSha = (await ref())?.object?.sha;
  return state;
}

export async function publishedPreflight({ cache, startedAt = new Date().toISOString(), now = () => new Date(),
  readState = (target, start, signal) => readPublicationState(target, start, route => publicationRequest(route, signal)),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 21, delayMs = 15_000 } = {}) {
  const targetDate = latestCommonBenchmarkDate(cache);
  if (!isIsoDate(targetDate)) fail("BENCHMARK_PENDING");
  selectBenchmark(cache, targetDate); // includes exact row and dividend validation
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 21
      || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 15_000) fail("CONFIG");
  let pending = false;
  const signal = AbortSignal.timeout(300_000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) fail("PUBLICATION_WAIT_TIMEOUT");
    let state;
    try { state = await readState(targetDate, startedAt, signal); }
    catch (error) {
      if (error?.message === "FEE_CLOUD_PUBLICATION_CANDIDATE_FAILED") throw error;
      if (pending) fail("PUBLICATION_WAIT_UNVERIFIED");
      return { targetDate, outcome: "produce", reason: "publication-unverified" };
    }
    if (isPublishedTarget(state, targetDate, now())) return { targetDate, outcome: "already-published", mainSha: state.mainSha };
    if (state.mainSha !== state.finalMainSha) {
      if (attempt + 1 === attempts) fail("PUBLICATION_UNSTABLE");
    } else if (!state.pending && !pending) return { targetDate, outcome: "produce", reason: "target-not-published" };
    else pending = true;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  fail("PUBLICATION_WAIT_TIMEOUT");
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

// This transport records a separately reviewed accounting decision, never grants
// owner consent. It is local-only; no workflow, secret or source permission changes.
export function loadIncomeDateEvidence(payload,targetDate,filename) {
  const persisted=incomeDateEvidenceFromData(payload,targetDate);
  if(filename===undefined)return {evidence:persisted,checkCurrent(){}};
  const read=()=>{
    try {
      if(process.env.GITHUB_ACTIONS==='true'||!path.isAbsolute(filename))fail('INCOME_INPUT');
      const stat=fs.lstatSync(filename),directory=fs.statSync(path.dirname(filename));
      const resolved=fs.realpathSync(filename),relative=path.relative(ROOT,resolved);
      if(relative===''||(relative!=='..'&&!relative.startsWith(`..${path.sep}`))
        ||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(directory.mode&0o077)!==0
        ||stat.uid!==process.getuid()||directory.uid!==process.getuid()||stat.size<=0||stat.size>64*1024)fail('INCOME_INPUT');
      const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const before=fs.fstatSync(fd);
        if(before.ino!==stat.ino||before.dev!==stat.dev||before.size!==stat.size||(before.mode&0o077)!==0)fail('INCOME_INPUT');
        const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
        if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==stat.size)fail('INCOME_INPUT');
        return bytes;
      } finally {fs.closeSync(fd);}
    } catch {fail('INCOME_INPUT');}
  };
  const bytes=read();let incoming;
  try {
    const file=JSON.parse(bytes.toString('utf8'));
    if(!file||Object.keys(file).sort().join(',')!=='audits,schema,targetDate'
      ||file.schema!=='fee-console.income-date-evidence.v1'||file.targetDate!==targetDate
      ||!Array.isArray(file.audits)||!file.audits.length||file.audits.length>32
      ||file.audits.some(a=>!incomeDatePolicy.isNotification(a?.proof)))fail('INCOME_INPUT');
    incoming=incomeDatePolicy.point({d:targetDate,incomeDateAudits:file.audits}).incomeDateAudits;
  } catch {fail('INCOME_INPUT');}
  const evidence={...persisted};
  for(const audit of incoming) {
    if(Object.hasOwn(evidence,audit.eventKey)&&JSON.stringify(evidence[audit.eventKey])!==JSON.stringify(audit.proof))fail('INCOME_INPUT_CONFLICT');
    evidence[audit.eventKey]=audit.proof;
  }
  try {
    const point={d:targetDate,incomeDateAudits:Object.entries(evidence).map(([eventKey,proof])=>({eventKey,proof}))};
    incomeDatePolicy.point(point);
    incomeDatePolicy.timeline([...(payload.daily||[]).filter(p=>p.d!==targetDate),point]);
  } catch {fail('INCOME_INPUT_CONFLICT');}
  return {evidence,checkCurrent(){if(!read().equals(bytes))fail('INCOME_INPUT_CHANGED');}};
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
    if(options.reader&&cli['income-date-evidence-file']!==undefined)fail('INCOME_INPUT');
    const incomeInput=options.reader?{checkCurrent(){}}:loadIncomeDateEvidence(
      decryptCandidate(path.join(ROOT,'data.json'),process.env.FEE_DATA_KEY),targetDate,cli['income-date-evidence-file']);
    const reader = options.reader || new SharesightCloudReader({
      clientId: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,
      clientSecret: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,
      incomeDateEvidence:incomeInput.evidence,fetchImpl:options.fetchImpl,
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
      incomeInput.checkCurrent();
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
      incomeInput.checkCurrent();
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
      incomeInput.checkCurrent();
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
  'HEALTH_CREATE', 'ECONOMIC_RECHECK', 'HEALTH_VALIDATE', 'CLEANUP']);
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
  const cli = args(process.argv.slice(2));
  if (cli.mode === "published-preflight") {
    if (Object.keys(cli).some(key => !["mode", "benchmark-file"].includes(key))) fail("ARGUMENT");
    const result = await publishedPreflight({ cache: readJson(path.resolve(cli["benchmark-file"] || ""), 3 * 1024 * 1024) });
    console.log(JSON.stringify({ schema: "fee-console.published-preflight.v1", ...result }));
    return;
  }
  const result = await produce({ cli });
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
