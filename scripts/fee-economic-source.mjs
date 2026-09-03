// Read-only, unauthenticated acquisition of one already-authorized encrypted Gist.
// No key lookup, decryption, source write, public logging, or automatic execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "huanwujoy-crypto";
const FILE = "fee-console-db.json";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const CODES = new Set([
  "SOURCE_LOCATOR", "SOURCE_OPTIONS", "SOURCE_NETWORK", "SOURCE_TIMEOUT",
  "SOURCE_HTTP", "SOURCE_FORBIDDEN", "SOURCE_REDIRECT", "SOURCE_RESPONSE",
  "SOURCE_IDENTITY", "SOURCE_TRUNCATED", "SOURCE_FILE", "SOURCE_ENVELOPE",
  "SOURCE_REVISION", "SOURCE_ETAG", "SOURCE_CHANGED", "SOURCE_STORAGE", "SOURCE_CLOSED",
]);

export class SourceFetchError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : "SOURCE_RESPONSE";
    super(safe);
    this.name = "SourceFetchError";
    this.code = safe;
  }
}
const fail = code => { throw new SourceFetchError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const sourceFailureCode = error => error instanceof SourceFetchError && CODES.has(error.code)
  ? error.code : "SOURCE_RESPONSE";

async function readBody(response) {
  if (!response.body || typeof response.body.getReader !== "function") fail("SOURCE_RESPONSE");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY) fail("SOURCE_RESPONSE");
      chunks.push(Buffer.from(next.value));
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail("SOURCE_RESPONSE"); }
  } finally {
    // Do not wait indefinitely for an uncooperative stream to acknowledge cancel.
    Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function inspect(body, response, id) {
  if (!object(body) || body.id !== id || !object(body.owner)
      || body.owner.login !== OWNER || body.public !== false) fail("SOURCE_IDENTITY");
  if (body.truncated !== false) fail("SOURCE_TRUNCATED");
  const file = object(body.files) && Object.hasOwn(body.files, FILE) ? body.files[FILE] : null;
  if (!object(file) || file.filename !== FILE || typeof file.content !== "string") fail("SOURCE_FILE");
  if (file.truncated !== false) fail("SOURCE_TRUNCATED");
  const bytes = Buffer.from(file.content, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_FILE || file.size !== bytes.length) fail("SOURCE_FILE");
  let envelope;
  try { envelope = JSON.parse(file.content); } catch { fail("SOURCE_ENVELOPE"); }
  if (!object(envelope) || Object.keys(envelope).sort().join(",") !== "data,enc,v"
      || envelope.enc !== true || ![3, 4].includes(envelope.v)
      || typeof envelope.data !== "string" || envelope.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.data)) {
    fail("SOURCE_ENVELOPE");
  }
  // After the shape check, this is a flat object with only primitive values and
  // base64 data. Count its decoded key tokens so JSON.parse cannot hide duplicates.
  let keyTokens;
  try { keyTokens = [...file.content.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(match => JSON.parse(`"${match[1]}"`)); }
  catch { fail("SOURCE_ENVELOPE"); }
  if (keyTokens.length !== 3 || new Set(keyTokens).size !== 3) fail("SOURCE_ENVELOPE");
  const sealed = Buffer.from(envelope.data, "base64");
  if (sealed.length < 29 || sealed.toString("base64") !== envelope.data) fail("SOURCE_ENVELOPE");
  const revision = body.history?.[0]?.version;
  if (typeof revision !== "string" || !/^[a-f0-9]{40,64}$/i.test(revision)) fail("SOURCE_REVISION");
  const etag = response.headers.get("etag");
  if (typeof etag !== "string" || !/^(?:W\/)?"[^"\x00-\x20\x7f]{1,512}"$/.test(etag)) fail("SOURCE_ETAG");
  return { bytes, revision, etag, envelopeVersion: envelope.v };
}

async function readOnce(id, options) {
  const url = `https://api.github.com/gists/${id}`;
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    const response = await options.fetchImpl(url, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer", signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response || response.redirected || response.type === "opaqueredirect"
        || (response.status >= 300 && response.status < 400 && response.status !== 304)) fail("SOURCE_REDIRECT");
    if (response.status === 403) fail("SOURCE_FORBIDDEN");
    if (response.status !== 200) fail("SOURCE_HTTP");
    if (response.url && response.url !== url) fail("SOURCE_REDIRECT");
    return inspect(await readBody(response), response, id);
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceFetchError("SOURCE_TIMEOUT"));
    }, options.timeoutMs);
  });
  try { return await Promise.race([operation, deadline]); }
  catch (error) {
    if (error instanceof SourceFetchError) throw new SourceFetchError(sourceFailureCode(error));
    fail(controller.signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_NETWORK");
  } finally { clearTimeout(timer); }
}

async function readWithRetry(id, options) {
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try { return await readOnce(id, options); }
    catch (error) {
      if (!["SOURCE_NETWORK", "SOURCE_TIMEOUT"].includes(sourceFailureCode(error))
          || attempt + 1 === options.attempts) throw error;
    }
  }
}
function same(a, b) {
  return a.revision === b.revision && a.etag === b.etag && a.bytes.equals(b.bytes);
}
async function stableRead(id, options) {
  const first = await readWithRetry(id, options), second = await readWithRetry(id, options);
  if (!same(first, second)) fail("SOURCE_CHANGED");
  return first;
}

function checkedRoot(requested) {
  if (typeof requested !== "string" || !path.isAbsolute(requested)) fail("SOURCE_STORAGE");
  let root;
  try {
    root = fs.realpathSync(requested);
    if (!fs.statSync(root).isDirectory()) fail("SOURCE_STORAGE");
    for (let at = root; ; at = path.dirname(at)) {
      if (fs.existsSync(path.join(at, ".git"))) fail("SOURCE_STORAGE");
      if (at === path.dirname(at)) break;
    }
  } catch { fail("SOURCE_STORAGE"); }
  return root;
}

/**
 * Locator comes ONLY from FEE_ECON_GIST_ID. Pass mock fetchImpl for synthetic tests.
 * sourcePath is private runtime metadata, not a notification or public log field.
 * checkCurrent performs two new remote reads plus a local ciphertext integrity check.
 * This verifies acquisition/stability, NOT decryption, source business authority, or fees.
 */
export async function fetchEconomicSnapshot(options = {}) {
  if (!object(options) || Object.keys(options).some(key => !["fetchImpl", "tempRoot", "timeoutMs", "attempts"].includes(key))) {
    fail("SOURCE_OPTIONS");
  }
  const opts = { fetchImpl: globalThis.fetch, tempRoot: os.tmpdir(), timeoutMs: 10_000, attempts: 2, ...options };
  if (typeof opts.fetchImpl !== "function" || !Number.isInteger(opts.timeoutMs)
      || opts.timeoutMs < 1 || opts.timeoutMs > 10_000 || ![1, 2].includes(opts.attempts)) fail("SOURCE_OPTIONS");
  const id = process.env.FEE_ECON_GIST_ID;
  if (typeof id !== "string" || !/^(?:[a-f0-9]{20}|[a-f0-9]{32})$/.test(id)) fail("SOURCE_LOCATOR");
  const root = checkedRoot(opts.tempRoot);
  const expected = await stableRead(id, opts);
  let directory, sourcePath, directoryIdentity, closed = false;
  const checkedDirectory = () => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || stat.dev !== directoryIdentity.dev || stat.ino !== directoryIdentity.ino) fail("SOURCE_STORAGE");
    return stat;
  };
  const cleanup = () => {
    if (closed) return;
    try {
      if (directory && fs.existsSync(directory)) checkedDirectory();
      if (sourcePath && fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
      if (directory && fs.existsSync(directory)) fs.rmdirSync(directory);
      closed = true;
    } catch { fail("SOURCE_STORAGE"); }
  };
  try {
    directory = fs.mkdtempSync(path.join(root, "fee-economic-source-"));
    directoryIdentity = fs.lstatSync(directory);
    fs.chmodSync(directory, 0o700);
    sourcePath = path.join(directory, "encrypted-source.json");
    fs.writeFileSync(sourcePath, expected.bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(sourcePath, 0o600);
  } catch {
    try { cleanup(); } catch { /* Preserve a fixed storage error only. */ }
    fail("SOURCE_STORAGE");
  }
  const verifyLocal = () => {
    if (closed) fail("SOURCE_CLOSED");
    try {
      const parent = checkedDirectory(), stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()
          || (stat.mode & 0o777) !== 0o600 || (parent.mode & 0o777) !== 0o700
          || !fs.readFileSync(sourcePath).equals(expected.bytes)) fail("SOURCE_STORAGE");
    } catch { fail("SOURCE_STORAGE"); }
  };
  try { verifyLocal(); } catch (error) { try { cleanup(); } catch {} throw error; }
  return Object.freeze({
    sourcePath,
    envelopeVersion: expected.envelopeVersion,
    async checkCurrent() {
      verifyLocal();
      const current = await stableRead(id, opts);
      if (!same(expected, current)) fail("SOURCE_CHANGED");
      verifyLocal();
      return true;
    },
    cleanup,
  });
}

