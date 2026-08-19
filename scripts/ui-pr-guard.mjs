#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const [baseRef, headRef, originsPath, baselinePath] = process.argv.slice(2);
if (!baseRef || !headRef || !originsPath || !baselinePath) {
  console.error("usage: ui-pr-guard.mjs BASE_REF HEAD_REF ALLOWED_ORIGINS RISK_BASELINE");
  process.exit(2);
}

const fail = message => {
  console.error(`UI PR guard failed: ${message}`);
  process.exit(1);
};

const git = args => execFileSync("git", args, {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"]
});

const refRange = `${baseRef}...${headRef}`;
let changedFiles;
try {
  changedFiles = git(["diff", "--name-only", "-z", refRange])
    .split("\0")
    .filter(Boolean);
} catch {
  fail("could not compute the pull-request file list");
}

if (!changedFiles.includes("index.html")) {
  console.log("ui-pr-check: no index.html change; no UI policy applies");
  process.exit(0);
}

if (changedFiles.length !== 1 || changedFiles[0] !== "index.html") {
  fail("an index.html PR must change index.html only; policy, workflow, script, data, and documentation changes require a separate PR");
}

const diffCheck = spawnSync("git", ["diff", "--check", refRange, "--", "index.html"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (diffCheck.status !== 0) fail("git diff --check reported whitespace errors");

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
} catch {
  fail("the trusted UI risk baseline is missing or invalid");
}
if (!Number.isInteger(baseline.maxDiffLines) || baseline.maxDiffLines < 1 ||
    !baseline.maxOccurrences || typeof baseline.maxOccurrences !== "object") {
  fail("the trusted UI risk baseline has an invalid shape");
}

let numstat;
try {
  numstat = git(["diff", "--numstat", refRange, "--", "index.html"]).trim();
} catch {
  fail("could not measure the index.html diff");
}
const [addedRaw = "0", removedRaw = "0"] = numstat.split(/\s+/);
const added = Number(addedRaw), removed = Number(removedRaw);
if (!Number.isInteger(added) || !Number.isInteger(removed)) fail("index.html must remain a text file");
if (added + removed > baseline.maxDiffLines) {
  fail(`index.html diff is too large (${added + removed} lines; limit ${baseline.maxDiffLines}); split or escalate the review`);
}

const show = (ref, path) => {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    fail(`could not read ${path} at the requested revision`);
  }
};
const baseHtml = show(baseRef, "index.html");
const headHtml = show(headRef, "index.html");

const count = (source, regex) => (source.match(regex) || []).length;
const exactlyOne = (label, regex) => {
  if (count(headHtml, regex) !== 1) fail(`index.html must contain exactly one ${label}`);
};
exactlyOne("doctype", /<!doctype\s+html\b/gi);
exactlyOne("opening html element", /<html\b/gi);
exactlyOne("closing html element", /<\/html\s*>/gi);
exactlyOne("opening body element", /<body\b/gi);
exactlyOne("closing body element", /<\/body\s*>/gi);
if (/<base\b/i.test(headHtml)) fail("base elements are not allowed");

const scripts = [...headHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
if (!scripts.length) fail("index.html contains no inline script");
for (const [index, match] of scripts.entries()) {
  if (/\bsrc\s*=/i.test(match[1])) fail("external script sources are not allowed");
  try {
    // Syntax validation only. The script body is parsed but never executed.
    new Function(match[2]);
  } catch {
    fail(`inline script ${index + 1} has invalid JavaScript syntax`);
  }
}

let allowedOrigins;
try {
  allowedOrigins = new Set(fs.readFileSync(originsPath, "utf8")
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map(value => new URL(value).origin));
} catch {
  fail("the trusted origin allowlist is missing or invalid");
}
const literalOrigins = source => new Set(
  [...source.matchAll(/(?:https?:)?\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::[0-9]+)?/gi)]
    .map(match => new URL(match[0].startsWith("//") ? `https:${match[0]}` : match[0]).origin)
);
for (const origin of literalOrigins(headHtml)) {
  if (!allowedOrigins.has(origin)) fail(`unapproved literal network origin: ${origin}`);
}

const riskPatterns = {
  fetch: /\bfetch\s*\(/g,
  XMLHttpRequest: /\b(?:new\s+)?XMLHttpRequest\b/g,
  sendBeacon: /\bsendBeacon\s*\(/g,
  WebSocket: /\bnew\s+WebSocket\s*\(/g,
  EventSource: /\bnew\s+EventSource\s*\(/g,
  Worker: /\bnew\s+(?:Shared)?Worker\s*\(/g,
  importScripts: /\bimportScripts\s*\(/g,
  dynamicImport: /\bimport\s*\(/g,
  serviceWorker: /\bserviceWorker\s*\.\s*register\s*\(/g,
  windowOpen: /\bwindow\s*\.\s*open\s*\(/g,
  locationAssign: /\b(?:window\s*\.\s*)?location\s*(?:=|\.\s*(?:assign|replace)\s*\()/g,
  ImageCtor: /\bnew\s+Image\s*\(/g,
  metaRefresh: /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/gi,
  localStorage: /\blocalStorage\b/g,
  sessionStorage: /\bsessionStorage\b/g,
  documentCookie: /\bdocument\s*\.\s*cookie\b/g,
  eval: /\beval\s*\(/g,
  FunctionCtor: /\bnew\s+Function\s*\(/g,
  atob: /\batob\s*\(/g,
  StringFromCharCode: /\bString\s*\.\s*fromCharCode\s*\(/g
};
for (const [name, regex] of Object.entries(riskPatterns)) {
  const limit = baseline.maxOccurrences[name];
  if (!Number.isInteger(limit) || limit < 0) fail(`risk baseline is missing ${name}`);
  const occurrences = count(headHtml, regex);
  if (occurrences > limit) fail(`${name} occurrences exceed the reviewed baseline (${occurrences} > ${limit})`);
}

const externalResourcePatterns = [
  /<(?:script|iframe|frame|embed|object|img|link)\b[^>]*(?:src|href|data)\s*=\s*["']\s*(?:https?:)?\/\//gi,
  /<form\b[^>]*\baction\s*=\s*["']\s*(?:https?:)?\/\//gi,
  /url\(\s*["']?(?:https?:)?\/\//gi
];
for (const regex of externalResourcePatterns) {
  if (count(headHtml, regex) > count(baseHtml, regex)) {
    fail("new external resource, form target, or CSS URL requires a separate security-policy review");
  }
}

let patch;
try {
  patch = git(["diff", "--unified=0", "--no-color", refRange, "--", "index.html"]);
} catch {
  fail("could not inspect the index.html patch");
}
const addedLines = patch.split(/\r?\n/)
  .filter(line => line.startsWith("+") && !line.startsWith("+++"))
  .map(line => line.slice(1))
  .join("\n");

const targetedSecrets = [
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["hard-coded fee data key", /\bFEE_DATA_KEY\b\s*[:=]\s*["'][^"']{8,}/],
  ["hard-coded bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i]
];
for (const [label, regex] of targetedSecrets) {
  if (regex.test(addedLines)) fail(`newly added lines contain a suspected ${label}`);
}
if (/\b(?:javascript|data\s*:\s*text\/html)\s*:/i.test(addedLines)) {
  fail("newly added executable URL scheme is not allowed");
}

console.log(`ui-pr-check: passed; index.html changed by +${added}/-${removed} lines`);
