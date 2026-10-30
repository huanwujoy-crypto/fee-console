#!/usr/bin/env node
// Local, one-time Codex source handoff. No manager write token is retained.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode } from "./fee-economic-source.mjs";
import { validateHealth } from "./fee-data-health.mjs";
import { validateFeeCalculationReceiptWithEcon, canonicalJson } from "./fee-receipt-core.mjs";
import { buildIbManagerReturnReceipt, buildIbManagerDrawdownReceipt, createIbManagerReturnConsumer, createIbManagerDrawdownConsumer } from "./ib-manager-return.mjs";
import { guardLegacySourceFile } from "./fee-legacy-source-file.mjs";
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {readVerifiedBrowserEvidence,consumeBrowserEvidence} from './fee-ratio-browser-evidence.mjs';
import {attachIbBootstrap} from './fee-ratio-packet.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import { createLegacyPolicy } from "./fee-legacy-policy.mjs";

const ACCOUNT = "huanwujoy-crypto";
const SERVICES = Object.freeze({
  key: "fee-console.codex.FEE_DATA_KEY",
  gist: "fee-console.codex.FEE_ECON_GIST_ID",
});
const GIST_RE = /^(?:[a-f0-9]{20}|[a-f0-9]{32})$/;
const KEY_RE = /^[A-Za-z0-9_+/-]{43}={0,2}$/;

// Local attachment/finalization never publishes, changes a ledger or treats a
// plan as authorization. Finalization derives health only from verified actual
// producer evidence, without extending its age. Both need exact-code approval.
const ATTACH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO_API = "https://api.github.com/repos/huanwujoy-crypto/fee-console";
const ATTACH_CODES = new Set(["PLAN", "LOCAL_ONLY", "PRIVATE_FILE", "INPUT_CHANGED", "HEALTH",
  "WINDOW", "PUBLIC_BASE", "CODE_CHANGED", "KEYCHAIN", "KEY", "LOCATOR", "SOURCE", "VERSION",
  "RECEIPT", "LEGACY_SOURCE", "PERIOD", "WRITER", "REPORTER", "NON_IB_CHANGED", "OUTPUT", "CLEANUP", "PROVENANCE", "HEALTH_WRITE"]);
export class LocalAttachmentError extends Error {
  constructor(code) { super("IB_LOCAL_" + (ATTACH_CODES.has(code) ? code : "OUTPUT")); this.name = "LocalAttachmentError"; }
}
const attachFail = code => { throw new LocalAttachmentError(code); };
const attachHash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const outside = (base, file) => { const r = path.relative(base, file); return r === ".." || r.startsWith(".." + path.sep); };
const gitBlob = bytes => crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const parseExact = bytes => createLegacyPolicy().parseExactJson(bytes);

function attachmentDirectory(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) attachFail("PRIVATE_FILE");
  const s = fs.lstatSync(file), real = fs.realpathSync(file);
  if (!s.isDirectory() || s.isSymbolicLink() || real !== file || (s.mode & 0o777) !== 0o700
      || s.uid !== process.getuid() || !outside(ATTACH_ROOT, real)) attachFail("PRIVATE_FILE");
  for (let at = real; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, ".git"))) attachFail("PRIVATE_FILE");
    if (at === path.dirname(at)) break;
  }
  return { path: real, dev: s.dev, ino: s.ino };
}
function attachmentFile(spec, directory) {
  if (!exact(spec, ["path", "sha256"]) || typeof spec.path !== "string" || !path.isAbsolute(spec.path)
      || path.dirname(spec.path) !== directory.path || !/^[a-f0-9]{64}$/.test(spec.sha256)) attachFail("PRIVATE_FILE");
  const read = () => {
    const d = attachmentDirectory(directory.path), s = fs.lstatSync(spec.path);
    if (d.dev !== directory.dev || d.ino !== directory.ino) attachFail("INPUT_CHANGED");
    if (!s.isFile() || s.isSymbolicLink() || fs.realpathSync(spec.path) !== spec.path || (s.mode & 0o777) !== 0o600
        || s.uid !== process.getuid() || s.size < 1 || s.size > 5 * 1024 * 1024) attachFail("PRIVATE_FILE");
    const fd = fs.openSync(spec.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const a = fs.fstatSync(fd), bytes = fs.readFileSync(fd), b = fs.fstatSync(fd);
      if (a.dev !== s.dev || a.ino !== s.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs
          || (a.mode & 0o777) !== 0o600 || a.uid !== process.getuid() || attachHash(bytes) !== spec.sha256) attachFail("INPUT_CHANGED");
      return { bytes, dev: a.dev, ino: a.ino };
    } finally { fs.closeSync(fd); }
  };
  const first = read(); return { ...first, check() { const next = read(); if (next.dev !== first.dev || next.ino !== first.ino || !next.bytes.equals(first.bytes)) attachFail("INPUT_CHANGED"); } };
}
function attachmentOwnedFile(file, directory) {
  const s = fs.lstatSync(file);
  if (path.dirname(file) !== directory.path || !s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600
      || s.uid !== process.getuid() || s.size < 1 || s.size > 5 * 1024 * 1024) attachFail("PRIVATE_FILE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let bytes;
  try { const a = fs.fstatSync(fd); if (a.dev !== s.dev || a.ino !== s.ino || (a.mode & 0o777) !== 0o600 || a.uid !== process.getuid()) attachFail("PRIVATE_FILE"); bytes = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  return attachmentFile({ path: file, sha256: attachHash(bytes) }, directory);
}
function attachmentDecode(bytes, version, key) {
  const outer = parseExact(bytes);
  if (!exact(outer, ["enc", "v", "data"]) || outer.enc !== true || outer.v !== version || typeof outer.data !== "string") attachFail("RECEIPT");
  const b = Buffer.from(outer.data, "base64"); if (b.length < 29 || b.toString("base64") !== outer.data) attachFail("RECEIPT");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16));
  const plain = Buffer.concat([d.update(b.subarray(12, -16)), d.final()]); try { return parseExact(plain); } finally { plain.fill(0); }
}

// Untrusted log bytes never reach a terminal or a log file. Preserve character
// boundaries: turn controls into inert text; do not strip/join them into proof.
// Only the trusted signer's canonical timestamped stdout is evidence.
export function readProducerLogRecord(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024) attachFail("PROVENANCE");
  let text; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { attachFail("PROVENANCE"); }
  const found = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, c => "\\u{" + c.codePointAt(0).toString(16) + "}");
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z) candidate ([a-f0-9]{40})$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== m[1].slice(0, 19)) attachFail("PROVENANCE");
    found.push({ at: m[1], oid: m[2] });
  }
  if (found.length !== 1) attachFail("PROVENANCE");
  return Object.freeze({ ...found[0] });
}

/** Fixed transport; overrides exist only for synthetic tests, not CLI options.
 * No retry, shell, logging, fallback credential, token, or write-capable request.
 */
export function createLocalAttachmentRuntime({ spawnImpl = spawnSync, fetchImpl = globalThis.fetch,
    now = () => new Date(), platform = process.platform } = {}) {
  const capture = (binary, args, options = {}) => {
    const r = spawnImpl(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      shell: false, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" }, ...options });
    return r;
  };
  const publicRead = async route => {
    if (![/^\/git\/ref\/heads\/main$/, /^\/commits\/[a-f0-9]{40}$/, /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/].some(r => r.test(route))) attachFail("PUBLIC_BASE");
    const url = PUBLIC_REPO_API + route, controller = new AbortController(); let timer;
    try {
      const operation = (async () => {
        const r = await fetchImpl(url, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
          referrerPolicy: "no-referrer", signal: controller.signal, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
        if (r.status !== 200 || r.redirected || (r.url && r.url !== url) || !r.body?.getReader) attachFail("PUBLIC_BASE");
        const reader = r.body.getReader(), chunks = []; let length = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 8 * 1024 * 1024) attachFail("PUBLIC_BASE"); chunks.push(Buffer.from(next.value)); } }
        finally { Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock(); }
        return parseExact(Buffer.concat(chunks));
      })();
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LocalAttachmentError("PUBLIC_BASE")); }, 10_000); })]);
    } catch { attachFail("PUBLIC_BASE"); } finally { clearTimeout(timer); }
  };
  return Object.freeze({ platform, now, publicRead,
    // Existing GitHub identity, fixed repository GETs, before financial keys.
    // Raw job text is kept in memory, never logged or treated as approval.
    githubRead(route) {
      const raw = /^actions\/jobs\/[1-9][0-9]{0,15}\/logs$/.test(route);
      if (!raw && !/^actions\/runs\/[1-9][0-9]{0,15}(?:\/jobs\?per_page=100)?$/.test(route)) attachFail("PROVENANCE");
      // Explicit per-request format opt-in needs exact-code/operator review.
      // It is permitted only for this fixed log route, captured as bytes in
      // pipes and normalized immediately. No terminal, pager or raw output.
      const r = capture("/Users/huanwu/.local/bin/gh", ["api", "--hostname", "github.com", "--method", "GET",
        ...(raw ? ["--allow-escape-sequences"] : []), "repos/huanwujoy-crypto/fee-console/" + route],
        { env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp", HOME: os.userInfo().homedir }, encoding: raw ? null : "utf8", maxBuffer: 2 * 1024 * 1024 });
      if (r.status !== 0 || r.error || String(r.stderr || "").trim()) attachFail("PROVENANCE");
      try { return raw ? readProducerLogRecord(r.stdout) : parseExact(Buffer.from(r.stdout || "")); } catch { attachFail("PROVENANCE"); }
    },
    git(args) { const r = capture("/usr/bin/git", args, { cwd: ATTACH_ROOT }); if (r.status !== 0 || r.error || String(r.stderr || "").trim()) attachFail("CODE_CHANGED"); return String(r.stdout || "").trim(); },
    readKeychain(service) {
      if (!Object.values(SERVICES).includes(service)) attachFail("KEYCHAIN");
      const r = capture("/usr/bin/security", ["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"], { maxBuffer: 4096 });
      if (r.status !== 0 || r.error || String(r.stderr || "").trim()) attachFail("KEYCHAIN"); return String(r.stdout || "").trim();
    },
    acquireEconomic(directory) { return fetchEconomicSnapshot({ fetchImpl, tempRoot: directory, attempts: 1 }); },
    runNode(request) { return capture(process.execPath, request.args, { cwd: ATTACH_ROOT, env: request.env, timeout: 20_000, maxBuffer: 4096 }); },
  });
}

async function attachmentPublicBase(base, health, runtime) {
  const ref = await runtime.publicRead("/git/ref/heads/main"), head = ref?.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(head || "") || runtime.git(["rev-parse", "HEAD"]) !== head
      || runtime.git(["status", "--porcelain", "--untracked-files=all"])) attachFail("CODE_CHANGED");
  const commit = await runtime.publicRead("/commits/" + head);
  if (commit?.sha !== head || commit?.commit?.verification?.verified !== true
      || commit?.author?.login !== ACCOUNT || commit?.author?.id !== 283054367 || !/^[a-f0-9]{40}$/.test(commit?.commit?.tree?.sha || "")) attachFail("PUBLIC_BASE");
  const tree = await runtime.publicRead("/git/trees/" + commit.commit.tree.sha + "?recursive=1");
  if (tree?.sha !== commit.commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) attachFail("PUBLIC_BASE");
  const seen = new Set(), scripts = [];
  for (const f of tree.tree) {
    if (typeof f.path !== "string" || seen.has(f.path)) attachFail("PUBLIC_BASE"); seen.add(f.path);
    if (f.path.startsWith("scripts/") && f.path.endsWith(".mjs")) {
      if (!/^scripts\/[a-z0-9-]+(?:\.test)?\.mjs$/.test(f.path) || f.type !== "blob" || f.mode !== "100644" || !/^[a-f0-9]{40}$/.test(f.sha || "")) attachFail("PUBLIC_BASE");
      scripts.push(f);
    }
  }
  if (!scripts.some(f => f.path === "scripts/codex-fee-credentials.mjs") || scripts.length < 10) attachFail("PUBLIC_BASE");
  const check = () => {
    if (runtime.git(["rev-parse", "HEAD"]) !== head || runtime.git(["status", "--porcelain", "--untracked-files=all"])) attachFail("CODE_CHANGED");
    for (const f of scripts) { const file = path.join(ATTACH_ROOT, f.path), s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || fs.realpathSync(file) !== file || gitBlob(fs.readFileSync(file)) !== f.sha) attachFail("CODE_CHANGED"); }
    for (const [name, bytes] of [["data.json", base.bytes], ["fee-data-health.json", health.bytes]]) { const f = tree.tree.find(x => x.path === name); if (f?.type !== "blob" || f.mode !== "100644" || f.sha !== gitBlob(bytes)) attachFail("PUBLIC_BASE"); }
  };
  check(); return { head, tree, check, async checkCurrent() { check(); if ((await runtime.publicRead("/git/ref/heads/main"))?.object?.sha !== head) attachFail("PUBLIC_BASE"); } };
}

async function attachmentProducerProof(evidence, base, healthFile, publicBase, runtime) {
  if (!exact(evidence, ["runId", "candidateSha"]) || !Number.isSafeInteger(evidence.runId) || evidence.runId < 1
      || !/^[a-f0-9]{40}$/.test(evidence.candidateSha || "") || typeof runtime.githubRead !== "function") attachFail("PROVENANCE");
  const run = await runtime.githubRead("actions/runs/" + evidence.runId);
  if (run?.id !== evidence.runId || run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1
      || !["workflow_dispatch", "schedule"].includes(run.event) || run.head_branch !== "main"
      || run.path !== ".github/workflows/fee-cloud-producer.yml" || run.head_repository?.full_name !== "huanwujoy-crypto/fee-console"
      || !/^[a-f0-9]{40}$/.test(run.head_sha || "")) attachFail("PROVENANCE");
  const listing = await runtime.githubRead("actions/runs/" + evidence.runId + "/jobs?per_page=100");
  if (!Array.isArray(listing?.jobs) || listing.jobs.length > 100 || listing.total_count !== listing.jobs.length
      || new Set(listing.jobs.map(j => j.id)).size !== listing.jobs.length) attachFail("PROVENANCE");
  const health = parseExact(healthFile.bytes);
  const producers = listing.jobs.filter(j => j.name === "produce" || ["daily","weekly","monthly"].some(kind => j.name === "Produce " + kind + " " + health.targetDate));
  if (producers.length !== 1) attachFail("PROVENANCE");
  const job = producers[0];
  const time = value => typeof value === "string" && /Z$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(job.id) || job.id < 1 || job.run_id !== run.id || job.head_sha !== run.head_sha
      || job.status !== "completed" || job.conclusion !== "success" || !Array.isArray(job.steps)
      || !Number.isFinite(time(job.started_at)) || !Number.isFinite(time(job.completed_at))
      || time(job.completed_at) < time(job.started_at) || time(health.checkedAt) < time(job.started_at)
      || time(health.checkedAt) > time(job.completed_at)) attachFail("PROVENANCE");
  for (const name of ["Read, calculate and validate the encrypted candidate", "Create a signed owner candidate"]) {
    const steps = job.steps.filter(s => s.name === name);
    if (steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") attachFail("PROVENANCE");
  }
  const commit = await runtime.publicRead("/commits/" + evidence.candidateSha);
  if (commit?.sha !== evidence.candidateSha || commit.commit?.verification?.verified !== true || commit.author?.id !== 283054367
      || commit.author?.login !== ACCOUNT || commit.commit?.message !== "daily " + health.targetDate
      || commit.parents?.length !== 1 || commit.parents[0].sha !== run.head_sha || !Array.isArray(commit.files)
      || commit.files.length < 1 || commit.files.length > 2 || new Set(commit.files.map(f => f.filename)).size !== commit.files.length
      || !commit.files.some(f => f.filename === "fee-data-health.json")
      || commit.files.some(f => f.status !== "modified" || !["data.json", "fee-data-health.json"].includes(f.filename))) attachFail("PROVENANCE");
  if (!/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha || "")) attachFail("PROVENANCE");
  const candidateTree = await runtime.publicRead("/git/trees/" + commit.commit.tree.sha + "?recursive=1");
  const sourceCommit = await runtime.publicRead("/commits/" + run.head_sha);
  if (sourceCommit?.sha !== run.head_sha || sourceCommit.commit?.verification?.verified !== true || sourceCommit.author?.id !== 283054367 || sourceCommit.author?.login !== ACCOUNT
      || !/^[a-f0-9]{40}$/.test(sourceCommit.commit?.tree?.sha || "")) attachFail("PROVENANCE");
  const sourceTree = await runtime.publicRead("/git/trees/" + sourceCommit.commit.tree.sha + "?recursive=1");
  for (const [tree, expected] of [[candidateTree, commit.commit.tree.sha], [sourceTree, sourceCommit.commit.tree.sha]])
    if (tree?.sha !== expected || tree.truncated !== false || !Array.isArray(tree.tree)
        || new Set(tree.tree.map(f => f.path)).size !== tree.tree.length) attachFail("PROVENANCE");
  for (const [name, bytes] of [["data.json", base.bytes], ["fee-data-health.json", healthFile.bytes]]) {
    const entry = candidateTree.tree.find(f => f.path === name);
    if (entry?.type !== "blob" || entry.mode !== "100644" || entry.sha !== gitBlob(bytes)) attachFail("PROVENANCE");
  }
  // Inherit style/source proof only when the runtime that produced it is still
  // the reviewed one. Exclude this local finalizer and tests; never infer style
  // success from a caller boolean, a nearby timestamp, or a changed producer.
  const critical = p => p === ".github/workflows/fee-cloud-producer.yml"
    || /^claude\/fee-[^/]+\.json$/.test(p)
    || (p.startsWith("scripts/") && p.endsWith(".mjs") && !p.endsWith(".test.mjs") && p !== "scripts/codex-fee-credentials.mjs");
  const paths = new Set([".github/workflows/fee-cloud-producer.yml", "scripts/fee-cloud-producer.mjs", "scripts/daily.mjs", "scripts/fee-data-health.mjs",
    ...[...publicBase.tree.tree, ...sourceTree.tree].filter(f => critical(f.path)).map(f => f.path)]);
  for (const name of paths) { const a = publicBase.tree.tree.find(f => f.path === name), b = sourceTree.tree.find(f => f.path === name);
    if (!a || !b || a.type !== "blob" || b.type !== "blob" || a.mode !== "100644" || b.mode !== "100644"
        || !/^[a-f0-9]{40}$/.test(a.sha || "") || a.sha !== b.sha) attachFail("PROVENANCE"); }
  const record = await runtime.githubRead("actions/jobs/" + job.id + "/logs"), signer = job.steps.find(s => s.name === "Create a signed owner candidate");
  // The API's whole-second completion time represents that second, not its
  // first millisecond. This does not extend checkedAt/target freshness limits.
  const completion = time(signer.completed_at), end = completion + (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(signer.completed_at || "") ? 999 : 0);
  if (!exact(record, ["at", "oid"]) || record.oid !== evidence.candidateSha || !Number.isFinite(time(record.at))
      || !Number.isFinite(time(signer.started_at)) || !Number.isFinite(completion) || completion < time(signer.started_at)
      || time(signer.started_at) < time(job.started_at) || completion > time(job.completed_at)
      || time(record.at) < time(signer.started_at) || time(record.at) > end) attachFail("PROVENANCE");
  return { runId: run.id, candidateSha: evidence.candidateSha, sourceHeadSha: run.head_sha, check() {
    if (health.dataSha256 !== attachHash(base.bytes)) attachFail("PROVENANCE");
  } };
}

/** Complete existing writer bytes; no encryption, publication, source refresh,
 * scheduling or new public schema. All inherited claims are re-proved here.
 */
export async function finalizeLocalIbAttachment({ plan, environ = process.env, checkPlan = () => {},
    runtime = createLocalAttachmentRuntime() } = {}) {
  let source, output, identity, keyText, key, env, result, errorCode, finalChecks, finalCandidateCheck, finalHealthCheck, healthAttempted = false;
  const cleanup = () => {
    if (!identity) return; const s = fs.lstatSync(output);
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== identity.dev || s.ino !== identity.ino) attachFail("CLEANUP");
    for (const n of ["data.json", "validation.json", ...(healthAttempted ? ["fee-data-health.json"] : [])]) {
      const f = path.join(output, n); if (fs.existsSync(f)) { const st = fs.lstatSync(f); if (!st.isFile() || st.isSymbolicLink()) attachFail("CLEANUP"); fs.unlinkSync(f); }
    } fs.rmdirSync(output); identity = undefined;
  };
  try {
    if (runtime.platform !== "darwin" || /^(true|1)$/i.test(String(environ.GITHUB_ACTIONS || ""))
        || process.execArgv.some(a => /^(?:--inspect(?:-brk|-wait)?|--(?:require|import|loader|experimental-loader|cpu-prof|heap-prof|trace-events-enabled|report-on-signal|report-on-fatalerror|heapsnapshot-signal)|-r)(?:=|$)/.test(a) || /^--heapsnapshot-near-heap-limit=(?!0$)/.test(a))
        || ["FEE_DATA_KEY", "FEE_ECON_GIST_ID", "FEE_ECON_GITHUB_TOKEN", "FEE_ECON_FILE", "FEE_ECON_V3_FILE", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH"].some(n => Object.hasOwn(environ, n))
        || Object.keys(environ).some(n => /^(?:DYLD_|LD_)/.test(n))) attachFail("LOCAL_ONLY");
    if (!exact(plan, ["schema", "targetDate", "workspace", "baseData", "baseHealth", "ibInput", "legacySource", "candidateData", "producerEvidence"])
        || plan.schema !== "fee-console.ib-local-finalize-plan.v1" || !/^\d{4}-\d{2}-\d{2}$/.test(plan.targetDate || "")) attachFail("PLAN");
    checkPlan(); const directory = attachmentDirectory(plan.workspace), base = attachmentFile(plan.baseData, directory), healthFile = attachmentFile(plan.baseHealth, directory), ib = attachmentFile(plan.ibInput, directory), candidate = attachmentFile(plan.candidateData, directory), legacy = plan.legacySource === null ? null : attachmentFile(plan.legacySource, directory), health = parseExact(healthFile.bytes);
    const fresh = () => { const now = runtime.now(), age = (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(plan.targetDate)) / 86_400_000;
      if (!Number.isInteger(age) || age < 0 || age > 4) attachFail("WINDOW");
      if (validateHealth(health, { now }).length || health.targetDate !== plan.targetDate || !["updated", "no-op"].includes(health.outcome)
          || health.dataSha256 !== attachHash(base.bytes) || health.sourceDates.schwab !== plan.targetDate || health.sourceDates.webull !== plan.targetDate
          || healthFile.bytes.toString() !== JSON.stringify(health, null, 2) + "\n") attachFail("HEALTH"); };
    const checks = () => { fresh(); checkPlan(); base.check(); healthFile.check(); ib.check(); candidate.check(); legacy?.check(); }; checks();
    output = path.join(directory.path, "finalized"); if (fs.existsSync(output)) attachFail("OUTPUT");
    const publicBase = await attachmentPublicBase(base, healthFile, runtime), proof = await attachmentProducerProof(plan.producerEvidence, base, healthFile, publicBase, runtime);
    const allChecks = () => { checks(); publicBase.check(); proof.check(); }; finalChecks = allChecks; allChecks();
    try { keyText = runtime.readKeychain(SERVICES.key); } catch { attachFail("KEYCHAIN"); }
    if (typeof keyText !== "string" || !KEY_RE.test(keyText)) attachFail("KEY"); key = Buffer.from(keyText.replace(/-/g, "+").replace(/_/g, "/"), "base64"); if (key.length !== 32) attachFail("KEY");
    let locator; try { locator = runtime.readKeychain(SERVICES.gist); } catch { attachFail("KEYCHAIN"); }
    if (typeof locator !== "string" || !GIST_RE.test(locator)) attachFail("LOCATOR");
    try { process.env.FEE_ECON_GIST_ID = locator; source = await runtime.acquireEconomic(directory.path); } catch { attachFail("SOURCE"); }
    finally { delete process.env.FEE_ECON_GIST_ID; locator = undefined; }
    if (source?.envelopeVersion !== 4 || typeof source.checkCurrent !== "function" || typeof source.cleanup !== "function") attachFail("VERSION");
    const sourceDirectory = attachmentDirectory(path.dirname(source.sourcePath)); if (path.dirname(sourceDirectory.path) !== directory.path) attachFail("PRIVATE_FILE");
    const econ = attachmentOwnedFile(source.sourcePath, sourceDirectory), economic = attachmentDecode(econ.bytes, 4, key), before = attachmentDecode(base.bytes, 3, key), after = attachmentDecode(candidate.bytes, 3, key), fee = before.feeCalculationReceipt;
    if (!validateFeeCalculationReceiptWithEcon(fee, before, economic).ok || !validateFeeCalculationReceiptWithEcon(after.feeCalculationReceipt, after, economic).ok) attachFail("RECEIPT");
    let checkLegacy; try { checkLegacy = guardLegacySourceFile(economic, key, plan.legacySource?.path || null); } catch { attachFail("LEGACY_SOURCE"); }
    const input = parseExact(ib.bytes), ret = await buildIbManagerReturnReceipt(input), dd = await buildIbManagerDrawdownReceipt(input), strip = v => Object.fromEntries(Object.entries(v).filter(([k]) => !["ibManagerReturnReceipt", "ibManagerDrawdownReceipt"].includes(k)));
    if (fee.asOf !== plan.targetDate || ret.start !== fee.start || ret.asOf !== plan.targetDate) attachFail("PERIOD");
    if (canonicalJson(strip(before)) !== canonicalJson(strip(after)) || canonicalJson(fee) !== canonicalJson(after.feeCalculationReceipt)) attachFail("NON_IB_CHANGED");
    if (canonicalJson(after.ibManagerReturnReceipt) !== canonicalJson(ret) || canonicalJson(after.ibManagerDrawdownReceipt) !== canonicalJson(dd)) attachFail("RECEIPT");
    const feeView = { state: "verified", start: fee.start, asOf: fee.asOf, periods: fee.periods };
    if ((await createIbManagerReturnConsumer().project(ret, feeView, after.ibManagerSourceStatus)).state !== "verified"
        || (await createIbManagerDrawdownConsumer().project(dd, ret, feeView, after.ibManagerSourceStatus)).state !== "verified") attachFail("RECEIPT");
    if (candidate.bytes.equals(base.bytes)) attachFail("OUTPUT");
    env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", FEE_DATA_KEY: keyText, FEE_ECON_FILE: source.sourcePath }; if (legacy) env.FEE_ECON_V3_FILE = plan.legacySource.path;
    const run = async (args, expected, code) => { allChecks(); econ.check(); checkLegacy(); let r; try { r = await runtime.runNode({ args, env }); } catch { attachFail(code); }
      if (r?.status !== 0 || r.error || String(r.stderr || "").trim() || String(r.stdout || "").trim() !== expected) attachFail(code);
      allChecks(); econ.check(); checkLegacy(); };
    fs.mkdirSync(output, { mode: 0o700 }); identity = fs.lstatSync(output); const file = path.join(output, "data.json"), hf = path.join(output, "fee-data-health.json");
    fs.writeFileSync(file, candidate.bytes, { mode: 0o600, flag: "wx" }); const frozen = attachmentOwnedFile(file, attachmentDirectory(output)); finalCandidateCheck = () => frozen.check();
    await run([path.join(ATTACH_ROOT, "scripts/fee-receipt-report.mjs"), "--file=" + file, "--format=validate"], "receipt valid " + plan.targetDate, "REPORTER");
    frozen.check(); healthAttempted = true;
    await run([path.join(ATTACH_ROOT, "scripts/fee-data-health.mjs"), "create-success", "--out=" + hf, "--data=" + file, "--target-date=" + plan.targetDate,
      "--source-schwab=" + health.sourceDates.schwab, "--source-webull=" + health.sourceDates.webull, "--source-benchmark=" + health.sourceDates.benchmark,
      "--outcome=updated", "--style-preflight=pass", "--checked-at=" + health.checkedAt], "health ok " + plan.targetDate + " updated", "HEALTH_WRITE");
    const hs = fs.lstatSync(hf); if (!hs.isFile() || hs.isSymbolicLink() || hs.uid !== process.getuid()) attachFail("OUTPUT"); fs.chmodSync(hf, 0o600);
    const bound = attachmentOwnedFile(hf, attachmentDirectory(output)), actualHealth = parseExact(bound.bytes), expectedHealth = { ...health, outcome: "updated", dataSha256: attachHash(candidate.bytes) };
    if (validateHealth(actualHealth, { now: runtime.now() }).length || canonicalJson(actualHealth) !== canonicalJson(expectedHealth)
        || fs.readdirSync(output).sort().join(",") !== "data.json,fee-data-health.json") attachFail("HEALTH_WRITE");
    finalHealthCheck = () => bound.check(); frozen.check();
    try { await source.checkCurrent(); } catch { attachFail("SOURCE"); } await publicBase.checkCurrent(); allChecks(); frozen.check(); bound.check();
    result = { schema: "fee-console.ib-local-finalized.v1", status: "IB_LOCAL_BOUND_HEALTH_READY_FOR_REVIEW", targetDate: plan.targetDate, mainSha: publicBase.head,
      baseDataSha256: attachHash(base.bytes), candidateDataSha256: attachHash(candidate.bytes), inheritedProducerRunId: proof.runId,
      inheritedCandidateSha: proof.candidateSha, sourceCheckedAt: health.checkedAt, feeReceiptUnchanged: true, nonIbFieldsUnchanged: true,
      healthCreated: true, readyForSignedCandidate: true, publicationReady: false };
  } catch (error) { errorCode = error instanceof LocalAttachmentError ? error.message.slice(9) : "OUTPUT"; }
  finally { if (env) { delete env.FEE_DATA_KEY; delete env.FEE_ECON_FILE; delete env.FEE_ECON_V3_FILE; } key?.fill(0); keyText = undefined;
    try { source?.cleanup?.(); } catch { errorCode = "CLEANUP"; } if (errorCode) try { cleanup(); } catch { errorCode = "CLEANUP"; } }
  if (errorCode) attachFail(errorCode);
  try { finalChecks(); finalCandidateCheck(); finalHealthCheck(); const dir = attachmentDirectory(output); if (dir.dev !== identity.dev || dir.ino !== identity.ino) attachFail("OUTPUT");
    fs.writeFileSync(path.join(output, "validation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" }); attachmentOwnedFile(path.join(output, "validation.json"), dir);
  } catch (error) { try { cleanup(); } catch { attachFail("CLEANUP"); } if (error instanceof LocalAttachmentError) throw error; attachFail("OUTPUT"); }
  return result;
}

// Manager-only addition uses the same base/run/style/source gates, but constructs
// its cipher with the sole writer after those proofs; no opaque cipher admission.
export async function finalizeLocalRatioAttachment(options={}){
  if(!['fee-console.ratio-local-finalize-plan.v1','fee-console.ratio-local-finalize-plan.v2'].includes(options.plan?.schema))attachFail('PLAN');
  return finalizeLocalPrivateAttachment(options);
}
export async function finalizeLocalIbBootstrapAttachment(options={}){
  if(options.plan?.schema!=='fee-console.ib-bootstrap-local-finalize-plan.v1')attachFail('PLAN');
  return finalizeLocalPrivateAttachment(options);
}
async function finalizeLocalPrivateAttachment({ plan, environ = process.env, checkPlan = () => {},
    runtime = createLocalAttachmentRuntime() } = {}) {
  let source, output, identity, recipientCheck, keyText, key, env, recipientPath, result, errorCode, finalChecks, finalCandidateCheck, finalHealthCheck, healthAttempted = false;
  let browserProof=null;
  const cleanup = () => {
    if (!identity) return; const s = fs.lstatSync(output);
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== identity.dev || s.ino !== identity.ino) attachFail("CLEANUP");
    for (const n of ["data.json", "validation.json", ...(healthAttempted ? ["fee-data-health.json"] : [])]) {
      const f = path.join(output, n); if (fs.existsSync(f)) { const st = fs.lstatSync(f); if (!st.isFile() || st.isSymbolicLink()) attachFail("CLEANUP"); fs.unlinkSync(f); }
    } fs.rmdirSync(output); identity = undefined;
  };
  try {
    if (runtime.platform !== "darwin" || /^(true|1)$/i.test(String(environ.GITHUB_ACTIONS || ""))
        || process.execArgv.some(a => /^(?:--inspect(?:-brk|-wait)?|--(?:require|import|loader|experimental-loader|cpu-prof|heap-prof|trace-events-enabled|report-on-signal|report-on-fatalerror|heapsnapshot-signal)|-r)(?:=|$)/.test(a) || /^--heapsnapshot-near-heap-limit=(?!0$)/.test(a))
        || ["FEE_DATA_KEY", "FEE_ECON_GIST_ID", "FEE_ECON_GITHUB_TOKEN", "FEE_ECON_FILE", "FEE_ECON_V3_FILE", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH"].some(n => Object.hasOwn(environ, n))
        || Object.keys(environ).some(n => /^(?:DYLD_|LD_)/.test(n))) attachFail("LOCAL_ONLY");
    const bootstrapOnly=plan?.schema==='fee-console.ib-bootstrap-local-finalize-plan.v1';
    if (!exact(plan, ["schema", "targetDate", "workspace", "baseData", "baseHealth", "legacySource", "ibBootstrap", "producerEvidence",...(!bootstrapOnly?["ratioInput","ratioSourceDate","ratioKind"]:[]),...(plan.schema==='fee-console.ratio-local-finalize-plan.v2'?['browserEvidence']:[])])
        || !["fee-console.ib-bootstrap-local-finalize-plan.v1","fee-console.ratio-local-finalize-plan.v1","fee-console.ratio-local-finalize-plan.v2"].includes(plan.schema) || !/^\d{4}-\d{2}-\d{2}$/.test(plan.targetDate || "")) attachFail("PLAN");
    checkPlan(); const directory = attachmentDirectory(plan.workspace), base = attachmentFile(plan.baseData, directory), healthFile = attachmentFile(plan.baseHealth, directory), input = bootstrapOnly?null:attachmentFile(plan.ratioInput, directory), legacy = plan.legacySource === null ? null : attachmentFile(plan.legacySource, directory), health = parseExact(healthFile.bytes);
    if((bootstrapOnly&&plan.ibBootstrap===null)||(plan.ibBootstrap!==null&&!exact(plan.ibBootstrap,['baseline','coverage'])))attachFail('PLAN');
    const baseline=plan.ibBootstrap?attachmentFile(plan.ibBootstrap.baseline,directory):null,coverage=plan.ibBootstrap?attachmentFile(plan.ibBootstrap.coverage,directory):null;
    const browserPlan=plan.schema==='fee-console.ratio-local-finalize-plan.v2'?attachmentFile(plan.browserEvidence,directory):null;
    if(browserPlan)try{const staged=parseExact(browserPlan.bytes);browserProof=readVerifiedBrowserEvidence({planPath:plan.browserEvidence.path,expectedScopeId:staged.managerScopeId,input:parseExact(input.bytes),now:runtime.now()});}catch{attachFail('SOURCE');}
    const fresh = () => { const now = runtime.now(), age = (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(plan.targetDate)) / 86_400_000;
      if (!Number.isInteger(age) || age < 0 || age > 4) attachFail("WINDOW");
      if (validateHealth(health, { now }).length || health.targetDate !== plan.targetDate || !["updated", "no-op"].includes(health.outcome)
          || health.dataSha256 !== attachHash(base.bytes) || health.sourceDates.schwab !== plan.targetDate || health.sourceDates.webull !== plan.targetDate
          || healthFile.bytes.toString() !== JSON.stringify(health, null, 2) + "\n") attachFail("HEALTH"); };
    const checks = () => { fresh(); checkPlan(); base.check(); healthFile.check(); input?.check();baseline?.check();coverage?.check();browserPlan?.check();browserProof?.check();if(browserProof)consumeBrowserEvidence(browserProof,parseExact(input.bytes),browserProof.scopeId,runtime.now()); legacy?.check(); }; checks();
    output = path.join(directory.path, bootstrapOnly?"ib-bootstrap-finalized":"ratio-finalized"); if (fs.existsSync(output)) attachFail("OUTPUT");
    const publicBase = await attachmentPublicBase(base, healthFile, runtime), proof = await attachmentProducerProof(plan.producerEvidence, base, healthFile, publicBase, runtime);
    const allChecks = () => { checks(); publicBase.check(); proof.check(); }; finalChecks = allChecks; allChecks();
    try { keyText = runtime.readKeychain(SERVICES.key); } catch { attachFail("KEYCHAIN"); }
    if (typeof keyText !== "string" || !KEY_RE.test(keyText)) attachFail("KEY"); key = Buffer.from(keyText.replace(/-/g, "+").replace(/_/g, "/"), "base64"); if (key.length !== 32) attachFail("KEY");
    let locator; try { locator = runtime.readKeychain(SERVICES.gist); } catch { attachFail("KEYCHAIN"); }
    if (typeof locator !== "string" || !GIST_RE.test(locator)) attachFail("LOCATOR");
    try { process.env.FEE_ECON_GIST_ID = locator; source = await runtime.acquireEconomic(directory.path); } catch { attachFail("SOURCE"); }
    finally { delete process.env.FEE_ECON_GIST_ID; }
    if (source?.envelopeVersion !== 4 || typeof source.checkCurrent !== "function" || typeof source.cleanup !== "function") attachFail("VERSION");
    const sourceDirectory = attachmentDirectory(path.dirname(source.sourcePath)); if (path.dirname(sourceDirectory.path) !== directory.path) attachFail("PRIVATE_FILE");
    const econ = attachmentOwnedFile(source.sourcePath, sourceDirectory), economic = attachmentDecode(econ.bytes, 4, key), before = attachmentDecode(base.bytes, 3, key), fee = before.feeCalculationReceipt;
    if (!validateFeeCalculationReceiptWithEcon(fee, before, economic).ok) attachFail("RECEIPT");
    let checkLegacy; try { checkLegacy = guardLegacySourceFile(economic, key, plan.legacySource?.path || null); } catch { attachFail("LEGACY_SOURCE"); }
    const ratioCore=createFeeRatioCore(createRankedExposureCore(),crypto.webcrypto);
    let recipient;if(!bootstrapOnly)try { recipient=await ratioCore.validateRecipient(parseExact(Buffer.from(source.managerRecipientRaw||'')),await ratioCore.recipientScope(locator)); } catch { attachFail('SOURCE'); }
    locator=undefined;
    if(browserPlan)try{consumeBrowserEvidence(browserProof,parseExact(input.bytes),recipient.scopeId,runtime.now());}catch{attachFail('SOURCE');}
    if(fee.asOf!==plan.targetDate||(!bootstrapOnly&&(!['weekly','monthly','weekly-monthly','snapshot'].includes(plan.ratioKind)||!/^\d{4}-\d{2}-\d{2}$/.test(plan.ratioSourceDate||'')||plan.ratioSourceDate>fee.asOf)))attachFail('PERIOD');
    const sourceOptions=bootstrapOnly?{}:{requireManagerRecipient:true};
    try{await source.checkCurrent(sourceOptions);}catch{attachFail('SOURCE');}
    env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", FEE_DATA_KEY: keyText, FEE_ECON_FILE: source.sourcePath }; if (legacy) env.FEE_ECON_V3_FILE = plan.legacySource.path;
    const run = async (args, expected, code) => { allChecks(); econ.check(); checkLegacy(); let r; try { r = await runtime.runNode({ args, env }); } catch { attachFail(code); }
      if (r?.status !== 0 || r.error || String(r.stderr || "").trim() || String(r.stdout || "").trim() !== expected) attachFail(code);
      allChecks(); econ.check(); checkLegacy(); };
    fs.mkdirSync(output, { mode: 0o700 }); identity = fs.lstatSync(output); const file = path.join(output, "data.json"), hf = path.join(output, "fee-data-health.json");
    if(!bootstrapOnly){recipientPath=path.join(directory.path,'ratio-public-recipient.json');
      fs.writeFileSync(recipientPath,JSON.stringify(recipient),{mode:0o600,flag:'wx'});
      const recipientFile=attachmentOwnedFile(recipientPath,directory);recipientCheck=()=>recipientFile.check();}
    const writer=[path.join(ATTACH_ROOT,'scripts/daily.mjs'),'--file='+plan.baseData.path,...(bootstrapOnly?['--ib-bootstrap-only','--ib-bootstrap-output='+file]:['--ratio-only','--ratio-input='+plan.ratioInput.path,'--ratio-recipient='+recipientPath,'--ratio-output='+file,'--ratio-kind='+plan.ratioKind,'--ratio-source-date='+plan.ratioSourceDate,'--ratio-scope='+recipient.scopeId]),...(browserPlan?['--ratio-evidence-plan='+plan.browserEvidence.path]:[]),...(baseline?['--ib-baseline-input='+plan.ibBootstrap.baseline.path,'--ib-coverage-input='+plan.ibBootstrap.coverage.path]:[])];
    await run(writer,bootstrapOnly?'IB_BOOTSTRAP_DRY_RUN_OK':'RATIO_ATTACHMENT_DRY_RUN_OK','WRITER');recipientCheck?.();
    await run([...writer,'--execute'],bootstrapOnly?'IB_BOOTSTRAP_ENCRYPTED_CANDIDATE_PREPARED':'RATIO_ATTACHMENT_ENCRYPTED_CANDIDATE_PREPARED','WRITER');recipientCheck?.();
    const frozen = attachmentOwnedFile(file, attachmentDirectory(output)); finalCandidateCheck = () => frozen.check();
    const after=attachmentDecode(frozen.bytes,3,key),expectedBase=baseline?await attachIbBootstrap(before,parseExact(baseline.bytes),parseExact(coverage.bytes)):before,strip=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['ratioManagerEnvelope','ratioManagerPublication'].includes(k)));
    if(canonicalJson(bootstrapOnly?expectedBase:strip(expectedBase))!==canonicalJson(bootstrapOnly?after:strip(after))||canonicalJson(fee)!==canonicalJson(after.feeCalculationReceipt))attachFail('NON_IB_CHANGED');
    if(!validateFeeCalculationReceiptWithEcon(after.feeCalculationReceipt,after,economic).ok)attachFail('RECEIPT');
    if(!bootstrapOnly)try{await ratioCore.validatePublication(after.ratioManagerEnvelope,after.ratioManagerPublication,fee);if(after.ratioManagerEnvelope.recipientId!==recipient.recipientId||after.ratioManagerEnvelope.scopeId!==recipient.scopeId||after.ratioManagerEnvelope.binding.sourceDate!==plan.ratioSourceDate||after.ratioManagerEnvelope.binding.previousCipherSha256!==(before.ratioManagerEnvelope?await ratioCore.digest(before.ratioManagerEnvelope):null))throw Error();}catch{attachFail('RECEIPT');}
    await run([path.join(ATTACH_ROOT, "scripts/fee-receipt-report.mjs"), "--file=" + file, "--format=validate"], "receipt valid " + plan.targetDate, "REPORTER");
    frozen.check(); healthAttempted = true;
    await run([path.join(ATTACH_ROOT, "scripts/fee-data-health.mjs"), "create-success", "--out=" + hf, "--data=" + file, "--target-date=" + plan.targetDate,
      "--source-schwab=" + health.sourceDates.schwab, "--source-webull=" + health.sourceDates.webull, "--source-benchmark=" + health.sourceDates.benchmark,
      "--outcome=updated", "--style-preflight=pass", "--checked-at=" + health.checkedAt], "health ok " + plan.targetDate + " updated", "HEALTH_WRITE");
    const hs = fs.lstatSync(hf); if (!hs.isFile() || hs.isSymbolicLink() || hs.uid !== process.getuid()) attachFail("OUTPUT"); fs.chmodSync(hf, 0o600);
    const bound = attachmentOwnedFile(hf, attachmentDirectory(output)), actualHealth = parseExact(bound.bytes), expectedHealth = { ...health, outcome: "updated", dataSha256: attachHash(frozen.bytes) };
    if (validateHealth(actualHealth, { now: runtime.now() }).length || canonicalJson(actualHealth) !== canonicalJson(expectedHealth)
        || fs.readdirSync(output).sort().join(",") !== "data.json,fee-data-health.json") attachFail("HEALTH_WRITE");
    finalHealthCheck = () => bound.check(); frozen.check();
    try { await source.checkCurrent(sourceOptions); } catch { attachFail("SOURCE"); } await publicBase.checkCurrent(); allChecks(); frozen.check(); bound.check();
    result = { schema: bootstrapOnly?"fee-console.ib-bootstrap-local-finalized.v1":"fee-console.ratio-local-finalized.v1", status: bootstrapOnly?"IB_BOOTSTRAP_BOUND_HEALTH_READY_FOR_REVIEW":"RATIO_LOCAL_BOUND_HEALTH_READY_FOR_REVIEW", targetDate: plan.targetDate, mainSha: publicBase.head,
      baseDataSha256: attachHash(base.bytes), candidateDataSha256: attachHash(frozen.bytes), inheritedProducerRunId: proof.runId,
      inheritedCandidateSha: proof.candidateSha, sourceCheckedAt: health.checkedAt, feeReceiptUnchanged: true, nonAttachmentFieldsUnchanged: true, ibBootstrapAdded: !!baseline,
      healthCreated: true, readyForSignedCandidate: true, publicationReady: false };
  } catch (error) { errorCode = error instanceof LocalAttachmentError ? error.message.slice(9) : "OUTPUT"; }
  finally { if (env) { delete env.FEE_DATA_KEY; delete env.FEE_ECON_FILE; delete env.FEE_ECON_V3_FILE; } key?.fill(0); keyText = undefined;
    if(recipientPath)try{recipientCheck();fs.unlinkSync(recipientPath);}catch{errorCode='CLEANUP';}
    try { source?.cleanup?.(); } catch { errorCode = "CLEANUP"; } if (errorCode) try { cleanup(); } catch { errorCode = "CLEANUP"; } }
  if (errorCode) attachFail(errorCode);
  try { finalChecks(); finalCandidateCheck(); finalHealthCheck(); const dir = attachmentDirectory(output); if (dir.dev !== identity.dev || dir.ino !== identity.ino) attachFail("OUTPUT");
    fs.writeFileSync(path.join(output, "validation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" }); attachmentOwnedFile(path.join(output, "validation.json"), dir);
  } catch (error) { try { cleanup(); } catch { attachFail("CLEANUP"); } if (error instanceof LocalAttachmentError) throw error; attachFail("OUTPUT"); }
  return result;
}

export function readLocalAttachmentPlan(file) {
  const directory = attachmentDirectory(path.dirname(file)), snapshot = attachmentOwnedFile(file, directory), plan = parseExact(snapshot.bytes);
  snapshot.check(); if (plan?.workspace !== directory.path) attachFail("PLAN"); return { plan, check: () => snapshot.check() };
}

export async function prepareLocalIbAttachment({ plan, environ = process.env, checkPlan = () => {},
    runtime = createLocalAttachmentRuntime() } = {}) {
  let source, output, identity, keyText, key, env, finalChecks, candidateCheck, result, errorCode;
  const cleanupOutput = () => {
    if (!identity) return; const s = fs.lstatSync(output);
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== identity.dev || s.ino !== identity.ino) attachFail("CLEANUP");
    for (const n of ["data.json", "validation.json"]) { const f = path.join(output, n); if (fs.existsSync(f)) { const st = fs.lstatSync(f); if (!st.isFile() || st.isSymbolicLink()) attachFail("CLEANUP"); fs.unlinkSync(f); } }
    fs.rmdirSync(output); identity = undefined;
  };
  try {
    const diagnosticLaunch = a => /^(?:--inspect(?:-brk|-wait)?|--(?:require|import|loader|experimental-loader|cpu-prof|heap-prof|trace-events-enabled|report-on-signal|report-on-fatalerror|heapsnapshot-signal)|-r)(?:=|$)/.test(a)
      || /^--heapsnapshot-near-heap-limit=(?!0$)/.test(a);
    if (runtime.platform !== "darwin" || /^(true|1)$/i.test(String(environ.GITHUB_ACTIONS || "")) || process.execArgv.some(diagnosticLaunch)) attachFail("LOCAL_ONLY");
    if (["FEE_DATA_KEY", "FEE_ECON_GIST_ID", "FEE_ECON_GITHUB_TOKEN", "FEE_ECON_FILE", "FEE_ECON_V3_FILE", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH"].some(n => Object.hasOwn(environ, n))
        || Object.keys(environ).some(n => /^(?:DYLD_|LD_)/.test(n))) attachFail("LOCAL_ONLY");
    if (!exact(plan, ["schema", "targetDate", "workspace", "baseData", "baseHealth", "ibInput", "legacySource"]) || plan.schema !== "fee-console.ib-local-attachment-plan.v1"
        || !/^\d{4}-\d{2}-\d{2}$/.test(plan.targetDate)) attachFail("PLAN");
    checkPlan(); const directory = attachmentDirectory(plan.workspace), base = attachmentFile(plan.baseData, directory), healthFile = attachmentFile(plan.baseHealth, directory), ib = attachmentFile(plan.ibInput, directory), legacy = plan.legacySource === null ? null : attachmentFile(plan.legacySource, directory);
    const checks = () => { checkPlan(); base.check(); healthFile.check(); ib.check(); legacy?.check(); }; finalChecks = checks;
    const health = parseExact(healthFile.bytes), now = runtime.now(), age = (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(plan.targetDate)) / 86_400_000;
    if (!Number.isInteger(age) || age < 0 || age > 4) attachFail("WINDOW");
    if (healthFile.bytes.toString() !== JSON.stringify(health, null, 2) + "\n" || validateHealth(health, { now }).length || !["updated", "no-op"].includes(health.outcome)
        || health.targetDate !== plan.targetDate || health.dataSha256 !== attachHash(base.bytes) || Object.values(health.sourceDates).some(d => d !== plan.targetDate)) attachFail("HEALTH");
    output = path.join(directory.path, "candidate"); if (fs.existsSync(output)) attachFail("OUTPUT");
    const publicBase = await attachmentPublicBase(base, healthFile, runtime);
    const allChecks = () => { checks(); publicBase.check(); }; finalChecks = allChecks;
    try { keyText = runtime.readKeychain(SERVICES.key); } catch { attachFail("KEYCHAIN"); }
    if (typeof keyText !== "string" || !KEY_RE.test(keyText)) attachFail("KEY"); key = Buffer.from(keyText.replace(/-/g, "+").replace(/_/g, "/"), "base64"); if (key.length !== 32) attachFail("KEY");
    let locator; try { locator = runtime.readKeychain(SERVICES.gist); } catch { attachFail("KEYCHAIN"); }
    if (typeof locator !== "string" || !GIST_RE.test(locator)) attachFail("LOCATOR");
    try { process.env.FEE_ECON_GIST_ID = locator; source = await runtime.acquireEconomic(directory.path); } catch { attachFail("SOURCE"); }
    finally { delete process.env.FEE_ECON_GIST_ID; locator = undefined; }
    if (source?.envelopeVersion !== 4 || typeof source.checkCurrent !== "function" || typeof source.cleanup !== "function") attachFail("VERSION");
    const sourceDirectory = attachmentDirectory(path.dirname(source.sourcePath)); if (path.dirname(sourceDirectory.path) !== directory.path) attachFail("PRIVATE_FILE");
    const econFile = attachmentOwnedFile(source.sourcePath, sourceDirectory), economic = attachmentDecode(econFile.bytes, 4, key), before = attachmentDecode(base.bytes, 3, key), fee = before.feeCalculationReceipt;
    if (!validateFeeCalculationReceiptWithEcon(fee, before, economic).ok) attachFail("RECEIPT");
    let checkLegacy; try { checkLegacy = guardLegacySourceFile(economic, key, plan.legacySource?.path || null); } catch { attachFail("LEGACY_SOURCE"); }
    const input = parseExact(ib.bytes), expectedReturn = await buildIbManagerReturnReceipt(input), expectedDrawdown = await buildIbManagerDrawdownReceipt(input);
    if (fee.asOf !== plan.targetDate || expectedReturn.start !== fee.start || expectedReturn.asOf !== plan.targetDate) attachFail("PERIOD");
    env = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", FEE_DATA_KEY: keyText, FEE_ECON_FILE: source.sourcePath }; if (legacy) env.FEE_ECON_V3_FILE = plan.legacySource.path;
    const run = async (args, expected, code) => {
      allChecks(); econFile.check(); checkLegacy(); let r; try { r = await runtime.runNode({ args, env }); } catch { attachFail(code); }
      if (r?.status !== 0 || r.error || String(r.stderr || "").trim() || String(r.stdout || "").trim() !== expected) attachFail(code);
      allChecks(); econFile.check(); checkLegacy();
    };
    const args = [path.join(ATTACH_ROOT, "scripts/daily.mjs"), "--ib-return-only", "--file=" + plan.baseData.path, "--ib-return-input=" + plan.ibInput.path];
    await run(args, "IB_RETURN_ATTACHMENT_DRY_RUN_OK", "WRITER");
    fs.mkdirSync(output, { mode: 0o700 }); identity = fs.lstatSync(output); const file = path.join(output, "data.json");
    await run([...args, "--execute", "--ib-return-output=" + file], "IB_RETURN_ENCRYPTED_CANDIDATE_PREPARED", "WRITER");
    if (fs.readdirSync(output).sort().join(",") !== "data.json") attachFail("OUTPUT");
    const out = attachmentOwnedFile(file, attachmentDirectory(output)); candidateCheck = () => out.check();
    const after = attachmentDecode(out.bytes, 3, key), strip = v => Object.fromEntries(Object.entries(v).filter(([k]) => !["ibManagerReturnReceipt", "ibManagerDrawdownReceipt"].includes(k)));
    if (canonicalJson(strip(before)) !== canonicalJson(strip(after)) || canonicalJson(fee) !== canonicalJson(after.feeCalculationReceipt)) attachFail("NON_IB_CHANGED");
    if (canonicalJson(after.ibManagerReturnReceipt) !== canonicalJson(expectedReturn) || canonicalJson(after.ibManagerDrawdownReceipt) !== canonicalJson(expectedDrawdown)
        || !validateFeeCalculationReceiptWithEcon(after.feeCalculationReceipt, after, economic).ok) attachFail("RECEIPT");
    await run([path.join(ATTACH_ROOT, "scripts/fee-receipt-report.mjs"), "--file=" + file, "--format=validate"], "receipt valid " + plan.targetDate, "REPORTER");
    try { await source.checkCurrent(); } catch { attachFail("SOURCE"); } await publicBase.checkCurrent(); allChecks(); out.check();
    result = { schema: "fee-console.ib-local-stage.v1", status: "IB_LOCAL_ATTACHMENT_STAGED_HEALTH_PENDING", targetDate: plan.targetDate, mainSha: publicBase.head,
      baseDataSha256: attachHash(base.bytes), candidateDataSha256: attachHash(out.bytes), feeReceiptUnchanged: true, nonIbFieldsUnchanged: true,
      healthCreated: false, publicationReady: false };
  } catch (error) { errorCode = error instanceof LocalAttachmentError ? error.message.slice(9) : "OUTPUT"; }
  finally {
    if (env) { delete env.FEE_DATA_KEY; delete env.FEE_ECON_FILE; delete env.FEE_ECON_V3_FILE; } key?.fill(0); keyText = undefined;
    try { source?.cleanup?.(); } catch { errorCode = "CLEANUP"; }
    if (errorCode) try { cleanupOutput(); } catch { errorCode = "CLEANUP"; }
  }
  if (errorCode) attachFail(errorCode);
  try { finalChecks(); candidateCheck(); const d = attachmentDirectory(output); if (d.dev !== identity.dev || d.ino !== identity.ino) attachFail("OUTPUT");
    fs.writeFileSync(path.join(output, "validation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" }); attachmentOwnedFile(path.join(output, "validation.json"), d);
    if (fs.existsSync(path.join(output, "fee-data-health.json"))) attachFail("OUTPUT");
  } catch (error) { try { cleanupOutput(); } catch { attachFail("CLEANUP"); } if (error instanceof LocalAttachmentError) throw error; attachFail("OUTPUT"); }
  return result;
}

export function parseManagerLink(input) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("MANAGER_LINK_INVALID"); }
  if (url.protocol !== "https:" || url.host !== "huanwujoy-crypto.github.io"
      || url.pathname !== "/fee-console/" || url.search) throw new Error("MANAGER_LINK_INVALID");
  const fields = new URLSearchParams(url.hash.slice(1));
  if (!fields.has("tok") || !fields.get("tok") || fields.getAll("gid").length !== 1
      || fields.getAll("k").length !== 1 || fields.getAll("tok").length !== 1) {
    throw new Error("MANAGER_LINK_INVALID");
  }
  const gist = fields.get("gid"), key = fields.get("k");
  if (!GIST_RE.test(gist) || !KEY_RE.test(key)) throw new Error("MANAGER_LINK_INVALID");
  const decoded = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (decoded.length !== 32) throw new Error("MANAGER_LINK_INVALID");
  return { gist, key }; // Deliberately excludes the manager write token.
}

export function readPrivateManagerLink(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
        || info.size < 1 || info.size > 4096) throw new Error("MANAGER_LINK_FILE_UNSAFE");
    return fs.readFileSync(fd, "utf8");
  } catch { throw new Error("MANAGER_LINK_FILE_UNSAFE"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readHidden(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      error ? reject(error) : resolve(value.trim());
    };
    const onData = chunk => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("CANCELLED"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
        if (byte < 32 || byte > 126 || value.length >= 4096) return finish(new Error("INPUT_INVALID"));
        value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

function save(service, value) {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-fee-keychain.c");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-keychain-"));
  const binary = path.join(dir, "store");
  try {
    const built = spawnSync("/usr/bin/cc", [source, "-framework", "Security", "-framework",
      "CoreFoundation", "-o", binary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    if (built.status !== 0) throw new Error("KEYCHAIN_STORE_FAILED");
    const result = spawnSync(binary, [service, ACCOUNT], {
      input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000,
    });
    if (result.status !== 0) throw new Error("KEYCHAIN_STORE_FAILED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function load(service) {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service,
      "-a", ACCOUNT, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
  } catch { throw new Error("KEYCHAIN_READ_FAILED"); }
}

async function sourceCheck() {
  const key = load(SERVICES.key), gist = load(SERVICES.gist);
  if (!KEY_RE.test(key) || Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64").length !== 32
      || !GIST_RE.test(gist)) throw new Error("KEYCHAIN_VALUE_INVALID");
  process.env.FEE_DATA_KEY = key;
  process.env.FEE_ECON_GIST_ID = gist;
  delete process.env.FEE_ECON_GITHUB_TOKEN;
  let snapshot;
  try {
    snapshot = await fetchEconomicSnapshot();
    if (snapshot.envelopeVersion !== 4) throw new Error("ECON_V4_REQUIRED");
    const outer = JSON.parse(fs.readFileSync(snapshot.sourcePath, "utf8"));
    const sealed = Buffer.from(outer.data, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm",
      Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64"), sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)),
      decipher.final()]);
    if (JSON.parse(plain.toString("utf8")).v !== 4) throw new Error("ECON_V4_REQUIRED");
    await snapshot.checkCurrent();
  } finally { snapshot?.cleanup(); }
  console.log("CODEX_FEE_SOURCE_READY_V4");
}

async function main() {
  if (process.argv[2] === 'finalize-ratio') {
    if(process.argv.length!==4||!path.isAbsolute(process.argv[3]))attachFail('PLAN');
    const input=readLocalAttachmentPlan(process.argv[3]);
    const result=await finalizeLocalRatioAttachment({plan:input.plan,checkPlan:input.check});
    console.log(result.status);return;
  }
  if (process.argv[2] === 'finalize-ib-bootstrap') {
    if(process.argv.length!==4||!path.isAbsolute(process.argv[3]))attachFail('PLAN');
    const input=readLocalAttachmentPlan(process.argv[3]);
    const result=await finalizeLocalIbBootstrapAttachment({plan:input.plan,checkPlan:input.check});
    console.log(result.status);return;
  }
  if (process.argv[2] === "finalize-ib") {
    if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3])) attachFail("PLAN");
    const input = readLocalAttachmentPlan(process.argv[3]);
    const result = await finalizeLocalIbAttachment({ plan: input.plan, checkPlan: input.check });
    console.log(result.status); return;
  }
  if (process.argv[2] === "attach-ib") {
    if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3])) attachFail("PLAN");
    const input = readLocalAttachmentPlan(process.argv[3]);
    const result = await prepareLocalIbAttachment({ plan: input.plan, checkPlan: input.check });
    console.log(result.status); return;
  }
  if ((process.argv[2] === "setup-file" && process.argv.length !== 4)
      || (process.argv[2] !== "setup-file" && process.argv.length !== 3)) {
    throw new Error("USAGE: setup | setup-file <private-link-file> | check");
  }
  if (process.argv[2] === "setup" || process.argv[2] === "setup-file") {
    const link = process.argv[2] === "setup-file"
      ? readPrivateManagerLink(process.argv[3])
      : await readHidden("粘贴迁移后的新管理人完整链接（输入不显示）");
    const { gist, key } = parseManagerLink(link);
    save(SERVICES.key, key);
    save(SERVICES.gist, gist);
    console.log("CODEX_FEE_CREDENTIALS_STORED");
  } else if (process.argv[2] === "check") {
    await sourceCheck();
  } else throw new Error("USAGE: setup | setup-file <private-link-file> | check");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    const known = new Set(["MANAGER_LINK_INVALID", "MANAGER_LINK_FILE_UNSAFE", "INTERACTIVE_TERMINAL_REQUIRED",
      "CANCELLED", "INPUT_INVALID", "KEYCHAIN_STORE_FAILED", "KEYCHAIN_READ_FAILED",
      "KEYCHAIN_VALUE_INVALID", "ECON_V4_REQUIRED"]);
    const code = error instanceof LocalAttachmentError ? error.message : error instanceof SourceFetchError ? sourceFailureCode(error)
      : known.has(error.message) ? error.message : "SOURCE_CHECK_FAILED";
    console.error(`CODEX_FEE_SETUP_FAILED:${code}`);
    process.exitCode = 1;
  });
}
