#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {expectedEditionAt, scheduledWatchEdition, scheduledWatchEnabled, slotStartEpoch} from "./xuan-ib-report-schedule.mjs";
export {expectedEditionAt, hktContext, slotDueEpoch, slotStartEpoch} from "./xuan-ib-report-schedule.mjs";

const EDITIONS = new Set(["am", "pm"]);

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

const stripMarkup = value => value
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&middot;|&#183;/gi, "·")
  .replace(/\s+/g, " ")
  .trim();

export function extractPrimaryDateLine(html) {
  const match = String(html).match(/<span\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  return match ? stripMarkup(match[1]) : "";
}

export function classifyEdition(dateLine) {
  const value = String(dateLine).toLowerCase();
  // Ad-hoc pages can contain wording such as "计划外加跑（常规 21:00）".
  // It must win over every AM/PM token so it can never prove a scheduled run.
  if (/计划外|加跑|补跑|临时|ad[ -]?hoc/.test(value)) return "adhoc";
  const am = /早间|上午|早班|(?:^|[\s·])am(?:$|[\s·])/.test(value);
  const pm = /睡前|晚间|定时正式版|(?:^|[\s·])pm(?:$|[\s·])/.test(value);
  if (am && pm) return "ambiguous";
  if (am) return "am";
  if (pm) return "pm";
  return "unknown";
}

const sameMeta = (left, right) => [
  "schemaVersion", "sourceSha", "sourceCommitEpoch", "dataDate", "htmlBlob"
].every(key => left?.[key] === right?.[key]);

export function evaluateFreshness({
  indexHtml,
  mainIndexHtml,
  onlineHtml,
  onlineMeta,
  mainHtml,
  mainMeta,
  expectedEdition,
  expectedDate,
  publicationHistory = [],
  now = new Date()
}) {
  const issues = [];
  const indexBytes = Buffer.isBuffer(indexHtml) ? indexHtml : Buffer.from(indexHtml);
  const mainIndexBytes = Buffer.isBuffer(mainIndexHtml) ? mainIndexHtml : Buffer.from(mainIndexHtml);
  const onlineBytes = Buffer.isBuffer(onlineHtml) ? onlineHtml : Buffer.from(onlineHtml);
  const mainBytes = Buffer.isBuffer(mainHtml) ? mainHtml : Buffer.from(mainHtml);
  const onlineBlob = gitBlobSha(onlineBytes);
  const mainBlob = gitBlobSha(mainBytes);
  const onlineIndexBlob = gitBlobSha(indexBytes);
  const mainIndexBlob = gitBlobSha(mainIndexBytes);
  const dateLine = extractPrimaryDateLine(onlineBytes.toString("utf8"));
  const actualEdition = classifyEdition(dateLine);
  const primaryDate = dateLine.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;

  if (!new Set(["am", "pm", "adhoc"]).has(actualEdition)) {
    issues.push(`fixed page edition is ${actualEdition}; expected an explicit AM, PM, or ad-hoc label`);
  }

  if (!indexBytes.includes(Buffer.from("latest.html"))) issues.push("fixed loader does not reference latest.html");
  if (!indexBytes.equals(mainIndexBytes)) issues.push("online index.html differs from main loader");
  if (onlineIndexBlob !== mainIndexBlob) issues.push("online and main loader Git blobs differ");
  if (!onlineBytes.equals(mainBytes)) issues.push("online latest.html differs from main");
  if (onlineBlob !== mainBlob) issues.push("online and main HTML Git blobs differ");
  if (!sameMeta(onlineMeta, mainMeta)) issues.push("online latest.meta.json differs from main");
  if (mainMeta?.htmlBlob !== mainBlob) issues.push("main metadata htmlBlob does not match main latest.html");
  if (onlineMeta?.htmlBlob !== onlineBlob) issues.push("online metadata htmlBlob does not match online latest.html");
  if (onlineMeta?.dataDate !== primaryDate) {
    issues.push(`online metadata and page dates differ: meta=${onlineMeta?.dataDate ?? "missing"}, page=${primaryDate ?? "missing"}`);
  } else if (!primaryDate || primaryDate < expectedDate) {
    issues.push(`expected HKT report date at least ${expectedDate}, got ${primaryDate ?? "missing"}`);
  }
  const sourceEpoch = onlineMeta?.sourceCommitEpoch;
  if (!Number.isInteger(sourceEpoch)) {
    issues.push("sourceCommitEpoch is missing or invalid");
  } else if (sourceEpoch > Math.floor(now.getTime() / 1000) + 300) {
    issues.push("source commit timestamp is more than five minutes in the future");
  }
  const scheduledEvidence = publicationHistory.filter(entry =>
    entry.valid === true &&
    entry.dataDate === expectedDate &&
    entry.edition === expectedEdition &&
    entry.sourceCommitEpoch >= slotStartEpoch(expectedDate, expectedEdition) &&
    entry.sourceCommitEpoch <= Math.floor(now.getTime() / 1000) + 300
  );
  if (scheduledEvidence.length === 0) {
    issues.push(`main publication history does not prove the scheduled ${expectedEdition.toUpperCase()} edition`);
  } else if (Number.isInteger(sourceEpoch)) {
    const newestScheduledEpoch = Math.max(...scheduledEvidence.map(entry => entry.sourceCommitEpoch));
    if (sourceEpoch < newestScheduledEpoch) {
      issues.push("fixed page predates the proven scheduled publication");
    }
  }
  return {
    ok: issues.length === 0,
    expectedDate,
    expectedEdition,
    primaryDate,
    actualEdition,
    onlineBlob,
    mainBlob,
    onlineIndexBlob,
    mainIndexBlob,
    sourceSha: onlineMeta?.sourceSha ?? null,
    sourceCommitEpoch: sourceEpoch ?? null,
    scheduledEvidence: scheduledEvidence.map(entry => ({
      commit: entry.commit,
      edition: entry.edition,
      sourceSha: entry.sourceSha,
      sourceCommitEpoch: entry.sourceCommitEpoch
    })),
    issues
  };
}

export function readPublicationHistory({cwd = process.cwd(), maxCount = 100} = {}) {
  const commits = execFileSync("git", [
    "log", `--max-count=${maxCount}`, "--format=%H", "--", "xuan-ib/latest.meta.json"
  ], {cwd, encoding: "utf8"}).trim().split(/\s+/).filter(Boolean);
  return commits.map(commit => {
    try {
      const meta = JSON.parse(execFileSync("git", ["show", `${commit}:xuan-ib/latest.meta.json`], {cwd, encoding: "utf8"}));
      const page = execFileSync("git", ["show", `${commit}:xuan-ib/latest.html`], {cwd});
      const line = extractPrimaryDateLine(page.toString("utf8"));
      const pageDate = line.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
      const blob = gitBlobSha(page);
      return {
        commit,
        dataDate: meta.dataDate,
        edition: classifyEdition(line),
        sourceSha: meta.sourceSha,
        sourceCommitEpoch: meta.sourceCommitEpoch,
        htmlBlob: blob,
        valid: pageDate === meta.dataDate && blob === meta.htmlBlob
      };
    } catch (error) {
      return {commit, valid: false, error: error.message};
    }
  });
}

const fetchBytes = async (url, fetchFn = fetch) => {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("health", `${Date.now()}-${Math.random()}`);
  const response = await fetchFn(requestUrl, {
    cache: "no-store",
    headers: {"Cache-Control": "no-cache"},
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`${requestUrl.pathname} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const joinUrl = (baseUrl, path) => new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;

export async function runWatcher({baseUrl, mainIndexHtml, mainHtml, mainMeta, publicationHistory = [], expectedEdition = "auto", scheduleExpression = "", now = new Date(), fetchFn = fetch}) {
  if (!scheduledWatchEnabled(scheduleExpression, now)) return {ok: true, skipped: true, reason: "inactive-seasonal-watch-slot"};
  // A late PM job must still audit PM, not accidentally turn into an AM check.
  let expected = scheduledWatchEdition(scheduleExpression) || expectedEdition;
  let expectedDate;
  if (expected === "auto") {
    const automatic = expectedEditionAt(now);
    if (!automatic.expectedEdition) {
      return {ok: true, skipped: true, reason: automatic.reason, expectedDate: automatic.date};
    }
    expected = automatic.expectedEdition;
    expectedDate = automatic.expectedDate;
  } else {
    const latestOfType = expectedEditionAt(now, expected);
    if (!latestOfType.expectedEdition) {
      return {ok: true, skipped: true, reason: latestOfType.reason, expectedDate: latestOfType.date};
    }
    expectedDate = latestOfType.expectedDate;
  }
  if (!EDITIONS.has(expected)) throw new Error("expected edition must be auto, am, or pm");
  const [indexBytes, onlineBytes, onlineMetaBytes] = await Promise.all([
    fetchBytes(joinUrl(baseUrl, "index.html"), fetchFn),
    fetchBytes(joinUrl(baseUrl, "latest.html"), fetchFn),
    fetchBytes(joinUrl(baseUrl, "latest.meta.json"), fetchFn)
  ]);
  return evaluateFreshness({
    indexHtml: indexBytes,
    mainIndexHtml,
    onlineHtml: onlineBytes,
    onlineMeta: JSON.parse(onlineMetaBytes.toString("utf8")),
    mainHtml,
    mainMeta,
    expectedEdition: expected,
    expectedDate,
    publicationHistory,
    now
  });
}

export async function runWatcherWithRetries({
  attempts = 4,
  intervalMs = 20_000,
  waitFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ...watcherOptions
}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer");
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("interval-ms must be non-negative");
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await runWatcher(watcherOptions);
      if (last.ok) return {...last, attempts: attempt};
    } catch (error) {
      last = {ok: false, issues: [`watch attempt failed: ${error.message}`]};
    }
    if (attempt < attempts) await waitFn(intervalMs);
  }
  return {...last, attempts};
}

export async function probePublication({baseUrl, expectedSha, expectedBlob, expectedDate, attempts = 20, intervalMs = 15_000, fetchFn = fetch, waitFn = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [htmlBytes, metaBytes] = await Promise.all([
        fetchBytes(joinUrl(baseUrl, "latest.html"), fetchFn),
        fetchBytes(joinUrl(baseUrl, "latest.meta.json"), fetchFn)
      ]);
      const meta = JSON.parse(metaBytes.toString("utf8"));
      const actualBlob = gitBlobSha(htmlBytes);
      const issues = [];
      if (meta.sourceSha !== expectedSha) issues.push(`sourceSha=${meta.sourceSha ?? "missing"}`);
      if (meta.htmlBlob !== expectedBlob) issues.push(`meta.htmlBlob=${meta.htmlBlob ?? "missing"}`);
      if (meta.dataDate !== expectedDate) issues.push(`dataDate=${meta.dataDate ?? "missing"}`);
      if (actualBlob !== expectedBlob) issues.push(`onlineHtmlBlob=${actualBlob}`);
      last = {attempt, issues, meta, actualBlob};
      if (issues.length === 0) return {ok: true, attempts: attempt, sourceSha: meta.sourceSha, htmlBlob: actualBlob, dataDate: meta.dataDate};
    } catch (error) {
      last = {attempt, issues: [error.message]};
    }
    if (attempt < attempts) await waitFn(intervalMs);
  }
  return {ok: false, attempts, reason: "Pages did not expose the promoted page within the probe window", last};
}

const option = (args, name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const baseUrl = option(args, "--base-url");
  if (!baseUrl) throw new Error("--base-url is required");
  if (command === "watch") {
    if (!scheduledWatchEnabled(option(args, "--schedule", ""))) {
      console.log(JSON.stringify({ok: true, skipped: true, reason: "inactive-seasonal-watch-slot"}));
      return;
    }
    const indexPath = option(args, "--main-index", "xuan-ib/index.html");
    const htmlPath = option(args, "--main-html", "xuan-ib/latest.html");
    const metaPath = option(args, "--main-meta", "xuan-ib/latest.meta.json");
    const result = await runWatcherWithRetries({
      baseUrl,
      mainIndexHtml: fs.readFileSync(indexPath),
      mainHtml: fs.readFileSync(htmlPath),
      mainMeta: JSON.parse(fs.readFileSync(metaPath, "utf8")),
      publicationHistory: readPublicationHistory(),
      expectedEdition: option(args, "--expected", "auto"),
      scheduleExpression: option(args, "--schedule", ""),
      attempts: Number(option(args, "--attempts", "4")),
      intervalMs: Number(option(args, "--interval-ms", "20000"))
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "probe") {
    const expectedSha = option(args, "--expected-sha");
    const expectedBlob = option(args, "--expected-blob");
    const expectedDate = option(args, "--expected-date");
    if (!expectedSha || !expectedBlob || !expectedDate) throw new Error("probe requires expected SHA, blob, and date");
    const result = await probePublication({
      baseUrl,
      expectedSha,
      expectedBlob,
      expectedDate,
      attempts: Number(option(args, "--attempts", "20")),
      intervalMs: Number(option(args, "--interval-ms", "15000"))
    });
    // A slow Pages rollout is evidence to report, not a reason to undo a valid
    // promotion or change the promotion job's exit code.
    console.log(JSON.stringify(result));
  } else {
    throw new Error("usage: xuan-ib-publish-health.mjs watch|probe --base-url URL ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`XUAN-IB publication health check failed: ${error.message}`);
    process.exitCode = 2;
  });
}
