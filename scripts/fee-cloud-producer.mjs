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
import { expectedTargetDate, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { boundedJson } from './fee-http-json.mjs';
import { isIsoDate, isWeekend, classifyFlow, flowId, inKindBusinessKey, notificationIncomeFlowAudit } from "./daily-core.mjs";
import { validateHealth } from "./fee-data-health.mjs";
import { STYLE_ACCOUNTS } from './fee-style-registry.mjs';
import {prepareIbManagerReport} from './ib-manager-report.mjs';
import {validateReportPlan,selectReportBenchmark} from './fee-report-period.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const fail = code => { throw new Error(`FEE_CLOUD_${code}`); };
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Private proposal transport only. The original style resolver and daily writer
// remain the sole validators/persistors. This file never grants owner consent.

const styleProposalFail = code => { throw new Error(`FEE_CLOUD_STYLE_PROPOSAL_${code}`); };
const styleProposalOutside = (root, target) => {
  const relative = path.relative(fs.realpathSync(root), target);
  return relative === '..' || relative.startsWith('..' + path.sep);
};

// One reviewed private recovery artifact. The digest is not human authorization.
// Changing this exact scope still requires protected code and private-input approval.
const PRIVATE_STYLE_RECOVERY_LOCK_SHA256 = "ccf950804e851df92a63f7c86601ac9d31026b35b24f36cb8719814e9afeeed6";
export function styleRecoveryLockDigest(lock) {
  return crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.keys(lock).sort().map(key => [key, lock[key]])))).digest('hex');
}
export function matchesPrivateStyleRecoveryLock(lock, targetDate) {
  return !!lock && typeof lock === 'object' && !Array.isArray(lock)
    && isIsoDate(targetDate) && lock.targetDate === targetDate
    && styleRecoveryLockDigest(lock) === PRIVATE_STYLE_RECOVERY_LOCK_SHA256;
}
export function verifyStyleRecoveryFirstHeld(input, proposal) {
  const source = input?.managementInput;
  if (!proposal || proposal.portfolioId !== STYLE_ACCOUNTS.webull
      || proposal.firstHeldOn !== proposal.effectiveFrom
      || !source || source.historyComplete !== true || source.date !== input.targetDate
      || !Array.isArray(source.holdings) || !Array.isArray(source.trades)) styleProposalFail('FIRST_HELD');
  const held = source.holdings.filter(row => row.portfolioId === proposal.portfolioId
    && row.holdingId === proposal.holdingId && row.ticker === proposal.ticker
    && row.account === 'webull' && row.sourceDate === input.targetDate);
  const history = source.trades.filter(row => row.portfolioId === proposal.portfolioId && row.holdingId === proposal.holdingId);
  const buys = history.filter(row => row.type === 'BUY');
  if (held.length !== 1 || !buys.length || history.some(row => row.confirmed !== true
      || !isIsoDate(row.date) || row.date < proposal.firstHeldOn || row.date > input.targetDate)
      || buys.map(row => row.date).sort()[0] !== proposal.firstHeldOn) styleProposalFail('FIRST_HELD');
}

export function loadStyleProposal(filename, targetDate, repoRoot, lockText) {
  if (filename === undefined) return { proposal: undefined, checkCurrent() {} };
  let lock, recoveryLock = false;
  try {
    lock = JSON.parse(lockText);
    recoveryLock = matchesPrivateStyleRecoveryLock(lock, targetDate);
    if (!recoveryLock && (!lock || Object.keys(lock).sort().join(',') !==
        'effectiveFrom,firstHeldOn,holdingId,portfolioId,proposalSha256,schema,style,targetDate,ticker'
        || lock.schema !== 'fee-console.style-proposal-lock.v1'
        || targetDate !== '2026-10-12' || lock.targetDate !== targetDate
        || !/^[a-f0-9]{64}$/.test(lock.proposalSha256)
        || lock.portfolioId !== STYLE_ACCOUNTS.schwab
        || !Number.isSafeInteger(lock.holdingId) || lock.holdingId <= 0
        || lock.ticker !== 'AMZN' || lock.style !== 'growth'
        || lock.firstHeldOn !== '2025-11-04' || lock.effectiveFrom !== lock.firstHeldOn)) styleProposalFail('LOCK');
  } catch { styleProposalFail('LOCK'); }
  const read = () => {
    try {
      if (!path.isAbsolute(filename)) styleProposalFail('INPUT');
      const stat = fs.lstatSync(filename), parent = fs.lstatSync(path.dirname(filename));
      const target = fs.realpathSync(filename);
      if (!styleProposalOutside(repoRoot, target) || !stat.isFile() || stat.isSymbolicLink()
          || !parent.isDirectory() || parent.isSymbolicLink()
          || (stat.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0
          || stat.uid !== process.getuid() || parent.uid !== process.getuid()
          || stat.size < 1 || stat.size > 64 * 1024) styleProposalFail('INPUT');
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd);
        if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size
            || (before.mode & 0o077) !== 0) styleProposalFail('INPUT');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || before.ctimeMs !== after.ctimeMs || bytes.length !== stat.size) styleProposalFail('INPUT');
        return {bytes, ino: before.ino, dev: before.dev, target};
      } finally { fs.closeSync(fd); }
    } catch { styleProposalFail('INPUT'); }
  };
  const first = read();
  if (crypto.createHash('sha256').update(first.bytes).digest('hex') !== lock.proposalSha256) styleProposalFail('HASH');
  let proposal;
  try {
    const input = JSON.parse(first.bytes.toString('utf8'));
    if (!input || Object.keys(input).sort().join(',') !== 'proposal,schema,targetDate'
        || input.schema !== 'fee-console.style-proposal.v1'
        || !isIsoDate(targetDate) || input.targetDate !== targetDate
        || !input.proposal || typeof input.proposal !== 'object' || Array.isArray(input.proposal)) styleProposalFail('INPUT');
    proposal = structuredClone(input.proposal);
    if (['portfolioId', 'holdingId', 'ticker', 'style', 'firstHeldOn', 'effectiveFrom']
      .some(key => proposal[key] !== lock[key])) styleProposalFail('SCOPE');
  } catch { styleProposalFail('INPUT'); }
  return { proposal, ...(recoveryLock ? { requiresFirstHeldProof: true } : {}), checkCurrent() {
    let current;
    try { current = read(); } catch { styleProposalFail('CHANGED'); }
    if (!current.bytes.equals(first.bytes) || current.ino !== first.ino
        || current.dev !== first.dev || current.target !== first.target) styleProposalFail('CHANGED');
  }};
}

export function mergeStyleProposal(styleInput, proposal) {
  if (proposal === undefined) return styleInput;
  if (!styleInput || !Array.isArray(styleInput.proposals) || styleInput.proposals.length) styleProposalFail('CONFLICT');
  return { ...structuredClone(styleInput), proposals: [structuredClone(proposal)] };
}

function args(argv) {
  const result = {};
  for (const raw of argv) {
    const match = /^--([a-z][a-z0-9-]*)=([\s\S]+)$/.exec(raw);
    if (!match || Object.hasOwn(result, match[1])) fail("ARGUMENT");
    result[match[1]] = match[2];
  }
  if (Object.keys(result).some(key => !["mode", "benchmark-file", "out-dir", "target-date", "checked-at", "income-date-evidence-file", "style-proposal-file"].includes(key))) fail("ARGUMENT");
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
  try { return await boundedJson(fetch, url, { headers, signal }, { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 }); }
  catch { fail('PUBLICATION_READ'); }
}

export async function readPublicationState(targetDate, startedAt, request = publicationRequest, {requireIb=false}={}) {
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
  if (mainSha !== finalMainSha || (!requireIb&&isPublishedTarget(state, targetDate))) return state;
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
  ibEnabled=process.env.IB_MANAGER_READ_ENABLED==='true',
  readState = (target, start, signal) => readPublicationState(target, start, route => publicationRequest(route, signal),{requireIb:ibEnabled}),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 21, delayMs = 15_000 } = {}) {
  const targetDate = expectedTargetDate(now());
  if (!isIsoDate(targetDate)) fail("BENCHMARK_PENDING");
  selectBenchmark(cache, targetDate); // includes exact row and dividend validation
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 21
      || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 15_000) fail("CONFIG");
  let pending = false,pendingMainSha=null;
  const signal = AbortSignal.timeout(300_000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) fail("PUBLICATION_WAIT_TIMEOUT");
    let state;
    try { state = await readState(targetDate, startedAt, signal); }
    catch (error) {
      if (error?.message === "FEE_CLOUD_PUBLICATION_CANDIDATE_FAILED") throw error;
      if (pending) fail("PUBLICATION_WAIT_UNVERIFIED");
      if (attempt + 1 === attempts) fail('PUBLICATION_UNVERIFIED');
      await sleep(delayMs);
      continue;
    }
    if (!ibEnabled&&isPublishedTarget(state, targetDate, now())) return { targetDate, outcome: "already-published", mainSha: state.mainSha };
    if(ibEnabled&&pending&&state.mainSha!==pendingMainSha&&isPublishedTarget(state,targetDate,now()))pending=false;
    if (state.mainSha !== state.finalMainSha) {
      if (attempt + 1 === attempts) fail("PUBLICATION_UNSTABLE");
    } else if (!state.pending && !pending) return { targetDate, outcome: "produce", reason: ibEnabled?'ib-verification-required':"target-not-published" };
    else {pending = true;pendingMainSha=state.mainSha;}
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
const WRITER_STYLE_CODES = new Set(["ACCOUNT", "ACCOUNT_STOCK_SUM", "AMOUNT", "BEFORE_FIRST_HOLDING",
    "CLASSIFIED_AT", "DATE", "DIRECTORY_PERMISSIONS", "EFFECTIVE_FIRST_HOLDING", "ENTRY_ID",
    "EVIDENCE_REQUIRED", "FILE_ABSOLUTE", "FILE_CHANGED", "FILE_IN_REPO", "FILE_PERMISSIONS",
    "FILE_SIZE", "FUTURE_CLASSIFICATION", "HOLDINGS", "HOLDING_DUPLICATE", "IDENTITY",
    "INDEPENDENT_REVIEW", "INPUT_DATE", "PROPOSAL_DUPLICATE", "PROPOSAL_NOT_HELD", "REGISTRY",
    "REGISTRY_CAPACITY", "REGISTRY_DUPLICATE", "REGISTRY_IMMUTABLE", "SCHEMA", "SOURCE_DATE",
    "STATIC_CONFLICT", "STATIC_IMMUTABLE", "STATIC_LEARNED_CONFLICT", "STATIC_MAP", "STOCK_SUM",
    "STYLE", "TICKER_CONFLICT", "TOP_HOLDINGS", "INPUT_REQUIRED", "INPUT_INVALID", "MANUAL_TOTALS_REFUSED"]);
const WRITER_FAILURE_PATTERNS = [
    [/^error: FEE_REPORT_METADATA_INVALID — nothing written$/m, "REPORT_METADATA_INVALID"],
    [/^error: FEE_REPORT_LOCKED_MONTH_CHANGED — nothing written$/m, "REPORT_LOCKED_MONTH_CHANGED"],
    [/^error: MANAGEMENT_EXEMPTION_INVALID — nothing written$/m, "MANAGEMENT_EXEMPTION_INVALID"],
    [/^error: MANAGEMENT_EXEMPTION_INPUT_REQUIRED — nothing written$/m, "MANAGEMENT_EXEMPTION_INPUT_REQUIRED"],
    [/^error: SOURCE_FILE_CHANGED — nothing written$/m, "SOURCE_FILE_CHANGED"],
    [/^TypeError:[^\r\n]*\n[ \t]+at /m, "UNCAUGHT_TYPE"],
    [/^ReferenceError:[^\r\n]*\n[ \t]+at /m, "UNCAUGHT_REFERENCE"],
    [/^SyntaxError:[^\r\n]*\n[ \t]+at /m, "UNCAUGHT_SYNTAX"],
    [/^RangeError:[^\r\n]*\n[ \t]+at /m, "UNCAUGHT_RANGE"],
    [/^error: STYLE_[A-Z0-9_]+(?: — nothing written)?$/m, "STYLE"],
    [/^error: duplicate\/stale cash in /m, "CASH_RECONCILIATION"],
    [/^error: --acct-cash-.* are required:/m, "CASH_EVIDENCE"],
    [/^error: (?:schwab|webull) moved .*refusing an impossible amount/m, "ACCOUNT_MOVE"],
    [/^error: fee calculation receipt failed:/m, "FEE_RECEIPT"],
    [/^error: FEE_ECON_FILE /m, "ECONOMIC_INPUT"],
    [/^error: IB_REPORT_INPUT_REFUSED(?: — nothing written)?$/m, "IB_INPUT"],
    [/^error: (?:private legacy source|current legacy economic input)/m, "ECONOMIC_SOURCE"],
    [/^error: flow /m, "FLOW"],
    [/^error: (?:split is impossible|growth\/value split is incomplete)/m, "SPLIT"],
    [/^error: --(?:date|src-|schwab|webull|cash|stock|other|spy|qqq)/m, "INPUT"],
  ];
const WRITER_PROCESS_FAILURES = ['PROCESS_TIMEOUT', 'PROCESS_ERROR', 'PROCESS_SIGNAL'];
export function writerFailureCode(stderr, preflight = false, result = null) {
  const text = String(stderr || "");
  const style = /^error: STYLE_([A-Z0-9_]+) — nothing written$/m.exec(text)?.[1];
  const processCategory = result?.error?.code === 'ETIMEDOUT' ? 'PROCESS_TIMEOUT'
    : result?.error ? 'PROCESS_ERROR' : result?.signal ? 'PROCESS_SIGNAL' : null;
  const category = processCategory || (WRITER_STYLE_CODES.has(style) ? `STYLE_${style}`
    : WRITER_FAILURE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] || "UNKNOWN");
  return `FEE_CLOUD_WRITER_${preflight ? "PREFLIGHT_" : ""}${category}`;
}
const WRITER_FAILURE_CODES = new Set(['', 'PREFLIGHT_'].flatMap(prefix =>
  ['UNKNOWN', ...WRITER_PROCESS_FAILURES, ...WRITER_FAILURE_PATTERNS.map(([,code]) => code),
    ...Array.from(WRITER_STYLE_CODES, code => 'STYLE_' + code)].map(code => 'FEE_CLOUD_WRITER_' + prefix + code)));
export const WRITER_DIAGNOSTIC_PREFIX = 'FEE_CLOUD_WRITER_DIAGNOSTIC=';
export function validateWriterFailureDiagnostic(value) {
  try {
    if (!diagnosticObject(value, ['schema','code','stage','termination','reportTarget','processingDate','processingIndex'])
        || value.schema !== 'fee-console.writer-diagnostic.v1' || !WRITER_FAILURE_CODES.has(value.code)
        || !['STYLE_PREFLIGHT','WEEKEND_CARRY','WRITER'].includes(value.stage)
        || value.code.includes('_PREFLIGHT_') !== (value.stage === 'STYLE_PREFLIGHT')) return false;
    const processKind = value.code.endsWith('_PROCESS_TIMEOUT') ? 'TIMEOUT'
      : value.code.endsWith('_PROCESS_ERROR') ? 'SPAWN_ERROR'
      : value.code.endsWith('_PROCESS_SIGNAL') ? 'SIGNAL' : null;
    if (processKind ? value.termination !== processKind : !['EXIT','UNKNOWN'].includes(value.termination)) return false;
    if ([value.reportTarget,value.processingDate,value.processingIndex].every(v => v === 'unknown')) return true;
    return isIsoDate(value.reportTarget) && isIsoDate(value.processingDate)
      && value.processingDate <= value.reportTarget
      && Number.isSafeInteger(value.processingIndex) && value.processingIndex >= 1 && value.processingIndex <= 10;
  } catch { return false; }
}
export function buildWriterFailureDiagnostic({code,stage,termination,context,targetDate} = {}) {
  const value = {schema:'fee-console.writer-diagnostic.v1',code,stage,termination,
    reportTarget:'unknown',processingDate:'unknown',processingIndex:'unknown'};
  if (context && context.processingDate === targetDate) {
    const bound = {...value,reportTarget:context.reportTarget,processingDate:context.processingDate,processingIndex:context.processingIndex};
    if (validateWriterFailureDiagnostic(bound)) return bound;
  }
  return validateWriterFailureDiagnostic(value) ? value : null;
}

function run(script, cli, env) {
  const result = spawnSync(NODE, [path.join(ROOT, "scripts", script), ...cli], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  if (result.status !== 0) {
    if (script === "daily.mjs") {
      const error = new Error(writerFailureCode(result.stderr, cli.includes("--style-preflight"), result));
      error.writerTermination = result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT'
        : result.error ? 'SPAWN_ERROR' : result.signal ? 'SIGNAL'
        : Number.isInteger(result.status) && result.status > 0 ? 'EXIT' : 'UNKNOWN';
      throw error;
    }
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

export function decryptCandidate(filename, keyText) {
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

// This single failure's public projection is closed and independent of Error
// metadata. Raw rows, identifiers and reasons remain in memory only. This does
// not grant event identity, change classification or remove persisted rows.
export const UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX = 'FEE_CLOUD_UNRESOLVED_FLOW_DIAGNOSTIC=';
const FLOW_DIAGNOSTIC_SCHEMA = 'fee-console.unresolved-flow-diagnostic.v1';
const FLOW_DIAGNOSTIC_LIMIT = 10000, FLOW_DIAGNOSTIC_GROUP_LIMIT = 32;
const FLOW_DIAGNOSTIC_REASON = new Map([
  ['bare DEPOSIT with no trade or transfer evidence', 'BARE_DEPOSIT'],
  ['bare WITHDRAWAL with no trade or transfer evidence', 'BARE_WITHDRAWAL'],
  ['verified dividend cash/collection fee awaits cash-posting date evidence', 'INCOME_DATE_PENDING'],
  ['dividend cash evidence is incomplete or inconsistent', 'INCOME_EVIDENCE_INCONSISTENT'],
  ['notification-date audit requires its own income evidence authority', 'INCOME_EVIDENCE_INCONSISTENT'],
  ['notification-date dividend evidence is incomplete or inconsistent', 'INCOME_EVIDENCE_INCONSISTENT'],
  ['external asset transfer lacks paired source/destination trade evidence', 'EXTERNAL_PROOF_MISSING'],
  ['evidence=external_transfer but no externalRef supplied', 'EXTERNAL_PROOF_MISSING'],
  ['no evidence either way', 'UNKNOWN'],
]);
const FLOW_DIAGNOSTIC_ORIGINS = new Set(['BASELINE', 'NEW', 'PERSISTED_AFTER_RECLASSIFICATION', 'UNKNOWN']);
const FLOW_DIAGNOSTIC_FACTS = ['tradePointer', 'holdingPointer', 'payoutPointer', 'principal', 'income', 'dateProof'];
const FLOW_DIAGNOSTIC_INCOME = new Set(['internal_income', 'internal_income_pending_date', 'internal_income_estimated', 'internal_income_owner_notification']);
const diagnosticObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const diagnosticCount = value => Number.isSafeInteger(value) && value >= 0 && value <= FLOW_DIAGNOSTIC_LIMIT;
const diagnosticDate = value => value === 'unknown' || isIsoDate(value);

export function validateUnresolvedFlowDiagnostic(value) {
  try {
    if (!diagnosticObject(value, ['schema','code','stage','runId','headSha','reportTarget','processingDate','processingIndex','unresolvedCount','overflowCount','groups','facts'])
        || value.schema !== FLOW_DIAGNOSTIC_SCHEMA || value.code !== 'FEE_CLOUD_UNRESOLVED_FLOW' || value.stage !== 'RECEIPT'
        || !(value.runId === 'unknown' || typeof value.runId === 'string' && /^[1-9]\d{0,19}$/.test(value.runId))
        || !(value.headSha === 'unknown' || typeof value.headSha === 'string' && /^[a-f0-9]{40}$/.test(value.headSha))
        || !diagnosticDate(value.reportTarget) || !diagnosticDate(value.processingDate)
        || !(value.processingIndex === 'unknown' || Number.isSafeInteger(value.processingIndex) && value.processingIndex >= 1 && value.processingIndex <= 10)
        || !diagnosticCount(value.unresolvedCount) || value.unresolvedCount === 0
        || !diagnosticCount(value.overflowCount) || value.overflowCount > value.unresolvedCount
        || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > FLOW_DIAGNOSTIC_GROUP_LIMIT
        || !diagnosticObject(value.facts, FLOW_DIAGNOSTIC_FACTS)) return false;
    const reasons = new Set([...FLOW_DIAGNOSTIC_REASON.values(),'UNSUPPORTED_SOURCE_TYPE']), seen = new Set(); let count = 0;
    for (const group of value.groups) {
      if (!diagnosticObject(group, ['flowDate','reasonCode','origin','count']) || !diagnosticDate(group.flowDate)
          || !reasons.has(group.reasonCode) || !FLOW_DIAGNOSTIC_ORIGINS.has(group.origin)
          || !diagnosticCount(group.count) || group.count === 0) return false;
      const key = JSON.stringify([group.flowDate, group.reasonCode, group.origin]);
      if (seen.has(key)) return false; seen.add(key); count += group.count;
    }
    if (count !== value.unresolvedCount) return false;
    if (value.overflowCount > 0 && (value.overflowCount !== value.unresolvedCount || value.groups.length !== 1
        || value.groups[0].flowDate !== 'unknown' || value.groups[0].reasonCode !== 'UNKNOWN'
        || value.groups[0].origin !== 'UNKNOWN' || value.groups[0].count !== value.unresolvedCount)) return false;
    for (const name of FLOW_DIAGNOSTIC_FACTS) {
      const fact = value.facts[name];
      if (!diagnosticObject(fact, ['true','false','unknown']) || !Object.values(fact).every(diagnosticCount)
          || fact.true + fact.false + fact.unknown !== value.unresolvedCount) return false;
    }
    return true;
  } catch { return false; }
}

export function buildUnresolvedFlowDiagnostic({payload, input, context, env = process.env} = {}) {
  try {
    const rows = payload?.flowsUnresolved;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > FLOW_DIAGNOSTIC_LIMIT) return null;
    const incoming = new Map(), flows = input?.flows;
    if (Array.isArray(flows) && flows.length <= FLOW_DIAGNOSTIC_LIMIT) for (const raw of flows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      // Mirror the writer's diagnostic association only; ordinary flowId is
      // deliberately never used here as proof of a real event or to clear data.
      const id = inKindBusinessKey(raw) || notificationIncomeFlowAudit(raw) ? flowId(raw)
        : raw.id != null && raw.id !== '' ? String(raw.id) : flowId(raw);
      if (!incoming.has(id)) incoming.set(id, []); incoming.get(id).push(raw);
    }
    const baselineIds = Array.isArray(context?.baselineUnresolvedIds)
      && context.baselineUnresolvedIds.length <= FLOW_DIAGNOSTIC_LIMIT
      && [...context.baselineUnresolvedIds].every(id => typeof id === 'string' && id.length > 0)
      ? context.baselineUnresolvedIds : null;
    const baseline = baselineIds && new Map();
    if (baseline) for (const id of baselineIds) baseline.set(id, (baseline.get(id) || 0) + 1);
    const facts = Object.fromEntries(FLOW_DIAGNOSTIC_FACTS.map(name => [name, {true:0,false:0,unknown:0}]));
    const groups = new Map();
    for (const row of rows) {
      const id = typeof row?.id === 'string' && row.id !== '' ? row.id : null;
      const matches = id === null ? null : incoming.get(id);
      const ambiguous = (id !== null && baseline?.get(id) > 1) || matches?.length > 1;
      const raw = !ambiguous && matches?.length === 1 ? matches[0] : null;
      const classification = raw ? classifyFlow(raw, {reference: input?.sourceReference != null}) : null;
      const origin = !ambiguous && baseline && id !== null ? baseline.has(id)
        ? raw && classification?.kind === 'internal' ? 'PERSISTED_AFTER_RECLASSIFICATION' : 'BASELINE'
        : raw ? 'NEW' : 'UNKNOWN' : 'UNKNOWN';
      const flowDate = isIsoDate(row?.date) ? row.date : 'unknown';
      let reasonCode = FLOW_DIAGNOSTIC_REASON.get(row?.reason) || 'UNKNOWN';
      if (row?.reason === 'no evidence either way' && raw && classification?.kind === 'unresolved'
          && typeof raw.type === 'string' && raw.type.trim() !== ''
          && !['DEPOSIT','WITHDRAWAL'].includes(raw.type.trim().toUpperCase())) reasonCode = 'UNSUPPORTED_SOURCE_TYPE';
      const key = JSON.stringify([flowDate, reasonCode, origin]);
      if (!groups.has(key)) groups.set(key, {flowDate, reasonCode, origin, count:0});
      groups.get(key).count++;
      // These flags describe fields/recognized tags in this uniquely matched
      // current input, not proven underlying financial facts. Missing fields
      // remain unknown, including a missing evidence tag or pointer field.
      const knownEvidence = raw && Object.hasOwn(raw, 'evidence')
        && (raw.evidence === null || ['internal_trade','external_transfer','external_asset_transfer',...FLOW_DIAGNOSTIC_INCOME].includes(raw.evidence));
      const values = raw ? {
        tradePointer: Object.hasOwn(raw, 'tradeId') ? raw.tradeId != null : 'unknown',
        holdingPointer: Object.hasOwn(raw, 'holdingId') ? raw.holdingId != null : 'unknown',
        // A resolver's sourcePayoutId is not the original source-row pointer.
        // Only the reader's explicit presence flag describes that native field.
        payoutPointer: Object.hasOwn(raw, 'payoutPointerPresent') && typeof raw.payoutPointerPresent === 'boolean' ? raw.payoutPointerPresent : 'unknown',
        principal: knownEvidence ? raw.evidence === 'internal_trade' && classification?.kind === 'internal' : 'unknown',
        income: knownEvidence ? FLOW_DIAGNOSTIC_INCOME.has(raw.evidence) : 'unknown',
        dateProof: typeof raw.incomeDateVerified === 'boolean' ? raw.incomeDateVerified : 'unknown',
      } : {};
      for (const name of FLOW_DIAGNOSTIC_FACTS) facts[name][values[name] === true ? 'true' : values[name] === false ? 'false' : 'unknown']++;
    }
    // Preserve the total, processing context and full fact counts even when
    // grouping would exceed its public bound. The fold claims no date/reason.
    const overflowCount = groups.size > FLOW_DIAGNOSTIC_GROUP_LIMIT ? rows.length : 0;
    const value = {schema:FLOW_DIAGNOSTIC_SCHEMA,code:'FEE_CLOUD_UNRESOLVED_FLOW',stage:'RECEIPT',
      runId:typeof env?.GITHUB_RUN_ID === 'string' && /^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : 'unknown',
      headSha:typeof env?.GITHUB_SHA === 'string' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ? env.GITHUB_SHA : 'unknown',
      reportTarget:isIsoDate(context?.reportTarget) ? context.reportTarget : 'unknown',
      processingDate:isIsoDate(context?.processingDate) ? context.processingDate : 'unknown',
      processingIndex:Number.isSafeInteger(context?.processingIndex) && context.processingIndex >= 1 && context.processingIndex <= 10 ? context.processingIndex : 'unknown',
      unresolvedCount:rows.length,overflowCount,
      groups:overflowCount ? [{flowDate:'unknown',reasonCode:'UNKNOWN',origin:'UNKNOWN',count:rows.length}] : [...groups.values()],facts};
    return validateUnresolvedFlowDiagnostic(value) ? value : null;
  } catch { return null; }
}

// The workflow uses this same validator before forwarding at most one safe
// projection. No other private stderr line is ever returned or printed.
export function safeProducerFailureSummary(privateStderr) {
  const fallback = {code:'FEE_CLOUD_FAILED',diagnostic:null};
  if (typeof privateStderr !== 'string' || Buffer.byteLength(privateStderr) > 65536) return fallback;
  const lines = privateStderr.replace(/\n$/, '').split('\n'), last = lines.at(-1);
  const code = SAFE_PRODUCER_FAILURE_CODES.has(last) ? last : fallback.code;
  const prefixes = [UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX, WRITER_DIAGNOSTIC_PREFIX];
  const candidates = lines.filter(line => prefixes.some(prefix => line.includes(prefix)));
  let diagnostic = null;
  const prefix = code === 'FEE_CLOUD_UNRESOLVED_FLOW' ? UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX
    : WRITER_FAILURE_CODES.has(code) ? WRITER_DIAGNOSTIC_PREFIX : null;
  if (prefix && candidates.length === 1) {
    const line = candidates[0];
    if (line.startsWith(prefix) && Buffer.byteLength(line) <= 16384) try {
      const json = line.slice(prefix.length), parsed = JSON.parse(json);
      // Canonical emission also rejects duplicate JSON keys before validation.
      if (JSON.stringify(parsed) === json && parsed.code === code
          && (prefix === WRITER_DIAGNOSTIC_PREFIX ? validateWriterFailureDiagnostic(parsed) : validateUnresolvedFlowDiagnostic(parsed))) diagnostic = parsed;
    } catch { /* private malformed metadata remains private */ }
  }
  return {code,diagnostic};
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
  if(input.sourceReference)cli.push(`--sharesight-reference=${JSON.stringify(input.sourceReference)}`);
  for (const account of ["schwab", "webull"]) if (Object.hasOwn(input.acctCash, account)) {
    cli.push(`--acct-cash-${account}=${input.acctCash[account]}`);
    if(!input.sourceReference)cli.push(`--prev-acct-cash-${account}=${input.prevAcctCash[account]}`);
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
    const targetDate = cli["target-date"] || expectedTargetDate(options.now ? options.now() : new Date());
    const benchmark = options.periodMode===true?selectReportBenchmark(cache,targetDate):selectBenchmark(cache, targetDate);
    const checkedAt = cli["checked-at"] || new Date().toISOString();
    const baseDataFile=options.baseDataFile||path.join(ROOT,'data.json');
    if(options.baseDataFile){
      const st=fs.lstatSync(baseDataFile),real=fs.realpathSync(baseDataFile),relative=path.relative(ROOT,real);
      if(!path.isAbsolute(baseDataFile)||!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid()||st.size<1||st.size>=2*1024*1024||!(relative==='..'||relative.startsWith('..'+path.sep)))fail('CANDIDATE');
    }
    if(options.reportPlan&&(!validateReportPlan(options.reportPlan)||options.reportPlan.accountingThrough!==targetDate))fail('REPORT_PLAN');
    if (options.reader && cli["style-proposal-file"] !== undefined) fail("STYLE_PROPOSAL_INPUT");
    const styleProposal = loadStyleProposal(cli["style-proposal-file"], targetDate, ROOT, process.env.FEE_STYLE_PROPOSAL_LOCK);
    stage = "READER_SETUP";
    if(options.reader&&cli['income-date-evidence-file']!==undefined)fail('INCOME_INPUT');
    const basePayloadForReader=options.reader?null:decryptCandidate(baseDataFile,process.env.FEE_DATA_KEY);
    const incomeInput=options.reader?{checkCurrent(){}}:loadIncomeDateEvidence(
      basePayloadForReader,targetDate,cli['income-date-evidence-file']);
    const reader = options.reader || new SharesightCloudReader({
      clientId: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,
      clientSecret: process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,
      incomeDateEvidence:incomeInput.evidence,fetchImpl:options.fetchImpl,sourceMode:'sharesight-reference',managementExemptionRegistry:basePayloadForReader.managementExemptionRegistry,
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
      if (styleProposal.requiresFirstHeldProof) verifyStyleRecoveryFirstHeld(input, styleProposal.proposal);
      input.styleInput = mergeStyleProposal(input.styleInput, styleProposal.proposal);
      styleProposal.checkCurrent();
      fs.writeFileSync(styleFile, `${JSON.stringify(input.styleInput)}\n`, { mode: 0o600, flag: "wx" });
      const managementFile = path.join(output, 'management-input.json');
      if (input.managementInput) fs.writeFileSync(managementFile, JSON.stringify(input.managementInput), {mode:0o600,flag:'wx'});
      fs.copyFileSync(baseDataFile, dataFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dataFile, 0o600);
      const env = { ...process.env, FEE_ECON_FILE: economic.sourcePath, FEE_STYLE_INPUT_FILE: styleFile, FEE_MANAGEMENT_INPUT_FILE: input.managementInput ? managementFile : '' };
      delete env.FEE_STYLE_PROPOSAL_JSON;
      delete env.FEE_STYLE_PROPOSAL_LOCK;
      const original = sha256(fs.readFileSync(dataFile));
      stage = "WEEKEND_CARRY";
      const weekendCarries = carryWeekendGap(dataFile, input.targetDate, env);
      const baseArgs = writerArgs(input, dataFile);
      stage = "STYLE_PREFLIGHT";
      styleProposal.checkCurrent();
      run("daily.mjs", [...baseArgs, "--style-preflight"], env);
      const ib=options.includeIb===false?null:await prepareIbManagerReport({payload:process.env.IB_MANAGER_READ_ENABLED==='true'?decryptCandidate(dataFile,process.env.FEE_DATA_KEY):null,targetDate,outputDir:output,reader:options.ibReader});
      if(ib)baseArgs.push(`--ib-manager-input=${ib.file}`);
      if(options.reportPlan)baseArgs.push(`--report-plan=${JSON.stringify(options.reportPlan)}`);
      stage = "WRITER";
      styleProposal.checkCurrent();
      incomeInput.checkCurrent();
      const writer = run("daily.mjs", baseArgs, env);
      const after = sha256(fs.readFileSync(dataFile));
      const outcome = verifyWriterOutcome(original, after, writer, targetDate, weekendCarries > 0);
      stage = "RECEIPT";
      const finalPayload=decryptCandidate(dataFile, process.env.FEE_DATA_KEY);
      if (finalPayload.flowsUnresolved?.length > 0) {
        const diagnostic = buildUnresolvedFlowDiagnostic({payload:finalPayload,input,context:options.flowDiagnosticContext});
        if (diagnostic) process.stderr.write(UNRESOLVED_FLOW_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic) + '\n');
      }
      assertCandidateReceiptable(finalPayload);
      run("fee-receipt-report.mjs", [`--file=${dataFile}`, "--format=validate"], env);
      stage = "HEALTH_CREATE";
      run("fee-data-health.mjs", ["create-success", `--out=${healthFile}`, `--data=${dataFile}`,
        `--target-date=${targetDate}`, `--source-schwab=${input.sourceDates.schwab}`,
        `--source-webull=${input.sourceDates.webull}`, `--source-benchmark=${input.benchmark.sourceDate}`,
        `--outcome=${outcome}`, "--style-preflight=pass", `--checked-at=${checkedAt}`], env);
      stage = "ECONOMIC_RECHECK";
      await economic.checkCurrent();
      incomeInput.checkCurrent();
      styleProposal.checkCurrent();
      stage = "HEALTH_VALIDATE";
      run("fee-data-health.mjs", ["validate", `--health=${healthFile}`, `--data=${dataFile}`], env);
      return { targetDate, outcome, retryCount: economicRead.retryCount + stableRead.retryCount, dataSha256: after, sourceDates: {
        schwab: input.sourceDates.schwab, webull: input.sourceDates.webull, benchmark: input.benchmark.sourceDate,
      }, dataFile, healthFile,...(ib?{ibManager:finalPayload.ibManagerSourceStatus}:{}) };
    } finally {
      try { fs.unlinkSync(styleFile); } catch { /* best effort */ }
      try { fs.unlinkSync(path.join(output, "management-input.json")); } catch { /* best effort */ }
      try { fs.unlinkSync(path.join(output, "ib-manager-input.json")); } catch { /* best effort */ }
      try { economic?.cleanup(); } catch (error) {
        throw new Error(producerFailureCode(error, "CLEANUP"));
      }
    }
  } catch (error) {
    const code = producerFailureCode(error, stage);
    const diagnostic = buildWriterFailureDiagnostic({code,stage,termination:error?.writerTermination,
      context:options.flowDiagnosticContext,targetDate:options.cli?.['target-date']});
    if (diagnostic) process.stderr.write(WRITER_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic) + '\n');
    throw new Error(code);
  }
}

// Only fixed program stages and exception categories may enter public diagnostics.
const DIAGNOSTIC_STAGES = new Set(['CONFIG', 'BENCHMARK', 'READER_SETUP', 'ECONOMIC_READ',
  'SOURCE_READ', 'PREPARE', 'WEEKEND_CARRY', 'STYLE_PREFLIGHT', 'WRITER', 'RECEIPT',
  'HEALTH_CREATE', 'ECONOMIC_RECHECK', 'HEALTH_VALIDATE', 'CLEANUP']);
const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EMFILE', 'EIO']);
// Literal program-defined failures only. A prefix match could expose arbitrary
// text supplied by a response, so unknown suffixes still use the safe category.
const NONCASH_DIAGNOSTICS = new Set(['ACTIVITY_UNVERIFIED', 'AMBIGUOUS_TRADES',
  'CASH_EVIDENCE', 'CASH_LEG', 'DATE', 'IDENTIFIED_SCOPE', 'IDENTITY', 'INCOMPLETE',
  'INSTRUMENT', 'PAIR_REQUIRED', 'PEER_REQUIRED', 'POSITION_DELTA', 'PROOF',
  'QUANTITY', 'SCOPE', 'SOURCE_MARK', 'TRADE', 'TRADE_CASH_UNVERIFIED',
  'UNSUPPORTED_TYPE', 'VALUATION'].map(code => 'FEE_NONCASH_' + code));
// Only source-defined literals and the existing finite diagnostic enums may
// leave the private failure file. A matching prefix alone grants no authority.
const SAFE_PRODUCER_FAILURE_CODES = new Set([
  ...`AMOUNT ARGUMENT AUTH_REJECTED AUTH_RESPONSE AUTH_UNAVAILABLE BENCHMARK_IDENTITY
    BENCHMARK_PENDING BENCHMARK_SCHEMA CANDIDATE CASH_ANCHOR_AMBIGUOUS CASH_ANCHOR_CHAIN
    CASH_ANCHOR_MISSING CASH_BALANCE_STALE CASH_CHAIN CASH_CURRENCY CASH_HISTORY_BOUNDARY
    CASH_HISTORY_EVIDENCE CASH_HISTORY_TARGET CASH_IDENTITY CASH_PRECISION CASH_PREVIOUS_EVIDENCE
    CASH_RECONCILIATION CASH_REPORT_BALANCE CASH_TRANSACTION_IDENTITY CONFIG CREDENTIALS DATE
    ECON_VERSION FAILED HEALTH HOLDING HOLDING_CATALOG_DATE_CONFLICT HOLDING_HISTORY_CURRENT
    HOLDING_HISTORY_IDENTITY HOLDING_HISTORY_INCEPTION HOLDING_HISTORY_REQUIRED HOLDING_HISTORY_UNSUPPORTED
    HOLDING_IDENTITY HOLDING_TERMINAL_CURRENT HOLDING_TERMINAL_IDENTITY HOLDING_TERMINAL_OPEN
    HOLDING_TERMINAL_PRECISION HOLDING_TERMINAL_REQUIRED HTTP_REJECTED IDENTITY INCOME_EVIDENCE
    INCOME_INPUT INCOME_INPUT_CHANGED INCOME_INPUT_CONFLICT INPUT_FILE MANAGEMENT_HISTORY_INCOMPLETE
    NONCASH_PEER_REQUIRED NON_USD_BALANCE_CHANGED NON_USD_EXTERNAL_FLOW NON_USD_MOVEMENT OUTPUT_DIR
    PERFORMANCE_IDENTITY PORTFOLIO_IDENTITY PUBLICATION_CANDIDATE_FAILED PUBLICATION_READ
    PUBLICATION_UNSTABLE PUBLICATION_UNVERIFIED PUBLICATION_WAIT_TIMEOUT PUBLICATION_WAIT_UNVERIFIED
    RECEIPT REPORT_PLAN RESPONSE_CREDENTIAL ROUTE_BLOCKED SCHEMA SOURCE_DUPLICATE SOURCE_INCOMPLETE
    SOURCE_MISSING SOURCE_MODE SOURCE_UNAVAILABLE SOURCE_UNSTABLE STYLE_PROPOSAL_INPUT
    TOTAL_RECONCILIATION TRADE_IDENTITY UNRESOLVED_FLOW WEEKEND_GAP WRITER_OUTCOME`.split(/\s+/).map(code=>'FEE_CLOUD_'+code),
  ...`ARGUMENT BASE_CHANGED BENCHMARK CLEANUP ECON_VERSION FUND_TRANSFER_INPUT_UNVERIFIED
    HISTORY_AHEAD_OF_TARGET IB_RECHECK_CHANGED_FEE_DATA IB_RETRY_METADATA MANUAL_SYNC_CONFIRMATION
    NOT_READY OUTPUT_DIR OUTPUT_EXISTS PLAN PUBLICATION_READ PUBLISHED_PERIOD_MISSING RANGE
    RECOVERY_CONFIRMATION RECOVERY_CONSUMED RECOVERY_METADATA RECOVERY_PRIOR_RUNS RECOVERY_RELEASE
    RECOVERY_REQUIRED RECOVERY_RUN RECOVERY_SCOPE SOURCE_ATTEMPT_METADATA SOURCE_RERUN_NOT_ALLOWED
    SOURCE_UNSTABLE TARGET`.split(/\s+/).map(code=>'FEE_REPORT_'+code),
  ...['FIRST_HELD','LOCK','INPUT','HASH','SCOPE','CHANGED','CONFLICT'].map(code=>'FEE_CLOUD_STYLE_PROPOSAL_'+code),
  ...['CONFIG','ABORTED','HTTP','TYPE','SIZE','BODY','JSON','TIMEOUT','NETWORK'].map(code=>'FEE_CLOUD_RESPONSE_'+code),
]);
for (const stage of [...DIAGNOSTIC_STAGES, 'UNKNOWN']) {
  for (const category of ['TYPE','RANGE','SYNTAX','REFERENCE','UNKNOWN',...Array.from(SYSTEM_CODES,code=>'SYSTEM_'+code),...Array.from(NONCASH_DIAGNOSTICS,code=>code.slice(4))])
    SAFE_PRODUCER_FAILURE_CODES.add(`FEE_CLOUD_STAGE_${stage}_${category}`);
}
for (const code of WRITER_FAILURE_CODES) SAFE_PRODUCER_FAILURE_CODES.add(code);
// SourceFetchError owns its finite enum; its constructor replaces unknown input
// with SOURCE_RESPONSE. No untyped SOURCE_* suffix is accepted by this boundary.
for (const code of ['LOCATOR','OPTIONS','AUTH_CONFIG','AUTH','NETWORK','TIMEOUT','HTTP','FORBIDDEN','REDIRECT','RESPONSE','IDENTITY','TRUNCATED','FILE','ENVELOPE','REVISION','ETAG','CHANGED','STORAGE','CLOSED']) {
  const literal='SOURCE_'+code;
  if (sourceFailureCode(new SourceFetchError(literal))===literal) SAFE_PRODUCER_FAILURE_CODES.add(literal);
}
export function producerFailureCode(error, stage) {
  if (error instanceof SourceFetchError) return sourceFailureCode(error);
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^FEE_CLOUD_[A-Z0-9_]{1,80}$/.test(message)) return message;
  if (NONCASH_DIAGNOSTICS.has(message)) {
    return `FEE_CLOUD_STAGE_${DIAGNOSTIC_STAGES.has(stage) ? stage : 'UNKNOWN'}_${message.slice(4)}`;
  }
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
    outcome: result.outcome, retryCount: result.retryCount, sourceDates: result.sourceDates, dataSha256: result.dataSha256,
    ...(result.ibManager?{ibManager:result.ibManager}:{}) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    const code = producerFailureCode(error, "UNKNOWN");
    console.error(code);
    process.exitCode = 1;
  });
}
