#!/usr/bin/env node
// Local, one-time Codex credential handoff.  No manager write token is retained.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchEconomicSnapshot } from "./fee-economic-source.mjs";

const ACCOUNT = "huanwujoy-crypto";
const SERVICES = Object.freeze({
  key: "fee-console.codex.FEE_DATA_KEY",
  gist: "fee-console.codex.FEE_ECON_GIST_ID",
  token: "fee-console.codex.FEE_ECON_GITHUB_TOKEN",
});
const GIST_RE = /^(?:[a-f0-9]{20}|[a-f0-9]{32})$/;
const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const KEY_RE = /^[A-Za-z0-9_+/-]{43}={0,2}$/;

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

export function validateReadToken(token) {
  if (!TOKEN_RE.test(token)) throw new Error("READ_TOKEN_INVALID");
  return token;
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
  const key = load(SERVICES.key), gist = load(SERVICES.gist), token = load(SERVICES.token);
  if (!KEY_RE.test(key) || Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64").length !== 32
      || !GIST_RE.test(gist)) throw new Error("KEYCHAIN_VALUE_INVALID");
  validateReadToken(token);
  process.env.FEE_DATA_KEY = key;
  process.env.FEE_ECON_GIST_ID = gist;
  process.env.FEE_ECON_GITHUB_TOKEN = token;
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
  if (process.argv.length !== 3) throw new Error("USAGE: setup | check");
  if (process.argv[2] === "setup") {
    const { gist, key } = parseManagerLink(await readHidden("粘贴原管理人完整链接（输入不显示）"));
    const token = validateReadToken(await readHidden("粘贴新的专用只读 GitHub PAT（输入不显示）"));
    save(SERVICES.key, key);
    save(SERVICES.gist, gist);
    save(SERVICES.token, token);
    console.log("CODEX_FEE_CREDENTIALS_STORED");
  } else if (process.argv[2] === "check") {
    await sourceCheck();
  } else throw new Error("USAGE: setup | check");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    const known = new Set(["MANAGER_LINK_INVALID", "READ_TOKEN_INVALID", "INTERACTIVE_TERMINAL_REQUIRED",
      "CANCELLED", "INPUT_INVALID", "KEYCHAIN_STORE_FAILED", "KEYCHAIN_READ_FAILED",
      "KEYCHAIN_VALUE_INVALID", "ECON_V4_REQUIRED"]);
    console.error(`CODEX_FEE_SETUP_FAILED:${known.has(error.message) ? error.message : "SOURCE_CHECK_FAILED"}`);
    process.exitCode = 1;
  });
}
