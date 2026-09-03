// Synthetic fixtures only. No real Gist, token, key, or financial input is read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode } from "./fee-economic-source.mjs";

const ID = "a".repeat(32), OWNER = "huanwujoy-crypto", NAME = "fee-console-db.json";
const TOKEN = "github_pat_" + "SYNTHETIC_NOT_A_REAL_TOKEN_".repeat(3);
process.env.FEE_ECON_GIST_ID = ID;
process.env.FEE_ECON_GITHUB_TOKEN = TOKEN;
const envelope = (v = 3) => JSON.stringify({ enc: true, v, data: Buffer.alloc(40, 7).toString("base64") }, null, 2) + "\n";
const fixture = (v = 3) => ({
  id: ID, public: false, owner: { login: OWNER }, truncated: false,
  history: [{ version: "b".repeat(40) }],
  files: { [NAME]: { filename: NAME, content: envelope(v), size: Buffer.byteLength(envelope(v)), truncated: false } },
});
function reply(body = fixture(), etag = '"synthetic-etag"', status = 200) {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { etag, "content-type": "application/json" } });
}
const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "fee-fetch-synthetic-"));
async function run(t, fetchImpl, options = {}) {
  const tempRoot = makeRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return fetchEconomicSnapshot({ fetchImpl, tempRoot, timeoutMs: 50, attempts: 2, ...options });
}
const rejected = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof SourceFetchError);
  assert.equal(error.message, code); assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
});

for (const v of [3, 4]) test(`v${v}: exact encrypted bytes, private modes, remote recheck, cleanup`, async t => {
  let calls = 0;
  const snapshot = await run(t, async (url, init) => {
    calls++;
    assert.equal(url, `https://api.github.com/gists/${ID}`);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Authorization", "X-GitHub-Api-Version"]);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return reply(fixture(v));
  });
  assert.equal(calls, 2); assert.equal(snapshot.envelopeVersion, v);
  assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope(v));
  assert.equal(fs.statSync(snapshot.sourcePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(snapshot.sourcePath)).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(snapshot).sort(), ["checkCurrent", "cleanup", "envelopeVersion", "sourcePath"]);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8").includes(TOKEN), false);
  assert.equal(await snapshot.checkCurrent(), true); assert.equal(calls, 4);
  snapshot.cleanup(); snapshot.cleanup(); assert.equal(fs.existsSync(snapshot.sourcePath), false);
  await rejected(snapshot.checkCurrent(), "SOURCE_CLOSED");
});

for (const [name, mutate, code] of [
  ["wrong owner", b => b.owner.login = "another-owner", "SOURCE_IDENTITY"],
  ["wrong id", b => b.id = "c".repeat(32), "SOURCE_IDENTITY"],
  ["public source", b => b.public = true, "SOURCE_IDENTITY"],
  ["missing visibility", b => delete b.public, "SOURCE_IDENTITY"],
  ["truncated Gist", b => b.truncated = true, "SOURCE_TRUNCATED"],
  ["missing truncation flag", b => delete b.truncated, "SOURCE_TRUNCATED"],
  ["truncated file", b => b.files[NAME].truncated = true, "SOURCE_TRUNCATED"],
  ["missing file", b => delete b.files[NAME], "SOURCE_FILE"],
  ["wrong file name", b => b.files[NAME].filename = "other.json", "SOURCE_FILE"],
  ["wrong file size", b => b.files[NAME].size++, "SOURCE_FILE"],
  ["missing revision", b => delete b.history, "SOURCE_REVISION"],
  ["blank revision", b => b.history[0].version = "", "SOURCE_REVISION"],
  ["unvalidated revision", b => b.history[0].version = "URL_OR_SECRET", "SOURCE_REVISION"],
]) test(name, async t => {
  let calls = 0; const body = fixture(); mutate(body);
  await rejected(run(t, async () => { calls++; return reply(body); }), code);
  assert.equal(calls, 1, "schema/identity failure never retries");
});

test("only the named file is selected", async t => {
  const body = fixture(); body.files["unrelated.txt"] = { content: "IGNORED-SYNTHETIC-TEXT" };
  const snapshot = await run(t, async () => reply(body));
  assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope()); snapshot.cleanup();
});

for (const raw of [
  "not-json", JSON.stringify({ enc: false, v: 3, data: "x" }),
  JSON.stringify({ enc: true, v: 2, data: "x" }),
  JSON.stringify({ enc: true, v: 3, data: "" }),
  JSON.stringify({ enc: true, v: 3, data: "not-base64" }),
  JSON.stringify({ enc: true, v: 3, data: Buffer.alloc(28).toString("base64") }),
  JSON.stringify({ enc: true, v: 3, data: Buffer.alloc(40).toString("base64"), plaintext: "FORBIDDEN" }),
]) test("reject invalid encrypted envelope " + raw.slice(0, 35), async t => {
  const body = fixture(); body.files[NAME].content = raw; body.files[NAME].size = Buffer.byteLength(raw);
  await rejected(run(t, async () => reply(body)), "SOURCE_ENVELOPE");
});

for (const status of [301, 302, 307, 308, 304, 401, 403, 404, 429, 500]) test(`HTTP ${status} is rejected without retry`, async t => {
  let calls = 0;
  await rejected(run(t, async () => { calls++; return reply({}, '"etag"', status); }),
    status === 401 ? "SOURCE_AUTH" : status === 403 ? "SOURCE_FORBIDDEN" :
      status >= 300 && status < 400 && status !== 304 ? "SOURCE_REDIRECT" : "SOURCE_HTTP");
  assert.equal(calls, 1);
});

test("reject redirected response even if it claims 200", async t => {
  const response = reply(); Object.defineProperty(response, "redirected", { value: true });
  await rejected(run(t, async () => response), "SOURCE_REDIRECT");
});
test("reject substituted response URL", async t => {
  const response = reply(); Object.defineProperty(response, "url", { value: "https://attacker.invalid/secret" });
  await rejected(run(t, async () => response), "SOURCE_REDIRECT");
});
for (const etag of ["", "unquoted", '"two words"']) test("reject invalid ETag " + JSON.stringify(etag), async t => {
  await rejected(run(t, async () => reply(fixture(), etag)), "SOURCE_ETAG");
});

for (const change of ["revision", "etag", "bytes"]) test(`initial double read detects changed ${change}`, async t => {
  let calls = 0;
  await rejected(run(t, async () => {
    const body = fixture(); const changed = ++calls === 2;
    if (changed && change === "revision") body.history[0].version = "c".repeat(40);
    if (changed && change === "bytes") { body.files[NAME].content += " "; body.files[NAME].size++; }
    return reply(body, changed && change === "etag" ? '"different"' : '"same"');
  }), "SOURCE_CHANGED");
  assert.equal(calls, 2);
});

for (const change of ["revision", "etag", "bytes"]) test(`checkCurrent detects subsequently changed ${change}`, async t => {
  let calls = 0;
  const snapshot = await run(t, async () => {
    const body = fixture(), changed = ++calls > 2;
    if (changed && change === "revision") body.history[0].version = "c".repeat(40);
    if (changed && change === "bytes") { body.files[NAME].content += " "; body.files[NAME].size++; }
    return reply(body, changed && change === "etag" ? '"different"' : '"same"');
  });
  await rejected(snapshot.checkCurrent(), "SOURCE_CHANGED");
  assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope(), "old snapshot is not overwritten");
  snapshot.cleanup();
});

test("network errors have at most two attempts and cannot leak their message", async t => {
  let calls = 0;
  await rejected(run(t, async () => { calls++; throw new Error(`${TOKEN} ${ID} https://private.invalid BODY-SECRET`); }), "SOURCE_NETWORK");
  assert.equal(calls, 2);
});
test("a single transient network error can recover within the bound", async t => {
  let calls = 0;
  const snapshot = await run(t, async () => { if (++calls === 1) throw new Error("NETWORK"); return reply(); });
  assert.equal(calls, 3); snapshot.cleanup();
});
test("non-cooperative fetch timeout is bounded", async t => {
  let calls = 0; const started = Date.now();
  await rejected(run(t, () => { calls++; return new Promise(() => {}); }, { timeoutMs: 5 }), "SOURCE_TIMEOUT");
  assert.equal(calls, 2); assert.ok(Date.now() - started < 500);
});
test("body streaming is covered by the timeout", async t => {
  let calls = 0;
  await rejected(run(t, async () => {
    calls++;
    return new Response(new ReadableStream({ start() {} }), { headers: { etag: '"ok"' } });
  }, { timeoutMs: 5 }), "SOURCE_TIMEOUT");
  assert.equal(calls, 2);
});
test("oversized API body is rejected", async t => {
  await rejected(run(t, async () => new Response("x".repeat(2 * 1024 * 1024 + 1))), "SOURCE_RESPONSE");
});
test("invalid response JSON is rejected with a static code", async t => {
  await rejected(run(t, async () => new Response("BODY-SECRET")), "SOURCE_RESPONSE");
});

test("invalid and URL-shaped locators cause no network request", async t => {
  for (const value of ["", "https://api.github.com/gists/" + ID, "../x", "TOKEN-SECRET", ID + "?x=1"]) {
    process.env.FEE_ECON_GIST_ID = value;
    let calls = 0;
    await rejected(run(t, async () => { calls++; return reply(); }), "SOURCE_LOCATOR");
    assert.equal(calls, 0);
  }
  process.env.FEE_ECON_GIST_ID = ID;
});
test("URL/token/locator options cannot be supplied", async t => {
  for (const option of ["url", "token", "gistId", "headers", "authorization", "credentials"]) {
    await rejected(run(t, async () => reply(), { [option]: "SECRET" }), "SOURCE_OPTIONS");
  }
  for (const attempts of [0, 3, Infinity]) await rejected(run(t, async () => reply(), { attempts }), "SOURCE_OPTIONS");
});
test("snapshot directories inside a repository are refused before fetch", async t => {
  const tempRoot = makeRoot(); fs.mkdirSync(path.join(tempRoot, ".git"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  let calls = 0;
  await rejected(fetchEconomicSnapshot({ tempRoot, fetchImpl: async () => { calls++; return reply(); } }), "SOURCE_STORAGE");
  assert.equal(calls, 0);
});
test("modified local ciphertext is rejected before a publication-time remote read", async t => {
  let calls = 0; const snapshot = await run(t, async () => { calls++; return reply(); });
  fs.appendFileSync(snapshot.sourcePath, " ");
  await rejected(snapshot.checkCurrent(), "SOURCE_STORAGE"); assert.equal(calls, 2); snapshot.cleanup();
});
test("weakened local permissions are rejected", async t => {
  const snapshot = await run(t, async () => reply()); fs.chmodSync(snapshot.sourcePath, 0o644);
  await rejected(snapshot.checkCurrent(), "SOURCE_STORAGE"); snapshot.cleanup();
});
test("helper emits no logs on success or failure, and formatter is whitelisted", async t => {
  const logs = [], old = { log: console.log, error: console.error, warn: console.warn };
  try {
    for (const key of Object.keys(old)) console[key] = (...args) => logs.push(args);
    const snapshot = await run(t, async () => reply()); snapshot.cleanup();
    await rejected(run(t, async () => { throw new Error(`${TOKEN} BODY-SECRET`); }), "SOURCE_NETWORK");
  } finally { Object.assign(console, old); }
  assert.deepEqual(logs, []);
  assert.equal(sourceFailureCode(new Error("TOKEN-SECRET")), "SOURCE_RESPONSE");
  assert.equal(new SourceFetchError("TOKEN-SECRET").message, "SOURCE_RESPONSE");
});

test("missing or malformed dedicated PAT fails before any request or snapshot write", async t => {
  const tempRoot = makeRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  try {
    for (const value of [undefined, "", " ", "github_pat_short", "ghp_" + "a".repeat(40),
      "gho_" + "a".repeat(40), "Bearer " + TOKEN, TOKEN + "\n", " " + TOKEN,
      TOKEN + "\r\nX-Secret: injected", TOKEN + "\t", TOKEN + "é", TOKEN + '"',
      "github_pat_" + "a".repeat(256)]) {
      if (value === undefined) delete process.env.FEE_ECON_GITHUB_TOKEN;
      else process.env.FEE_ECON_GITHUB_TOKEN = value;
      let calls = 0;
      await rejected(fetchEconomicSnapshot({ tempRoot, fetchImpl: async () => { calls++; return reply(); } }), "SOURCE_AUTH_CONFIG");
      assert.equal(calls, 0);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
    }
  } finally { process.env.FEE_ECON_GITHUB_TOKEN = TOKEN; }
});

test("generic GitHub credentials never substitute for the dedicated PAT", async t => {
  // These synthetic decoys must never be inspected by the production helper.
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ACCESS_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
    process.env[key] = "github_pat_" + "SYNTHETIC_GENERIC_DECOY_".repeat(3);
  }
  delete process.env.FEE_ECON_GITHUB_TOKEN;
  try {
    let calls = 0;
    await rejected(run(t, async () => { calls++; return reply(); }), "SOURCE_AUTH_CONFIG");
    assert.equal(calls, 0);
  } finally {
    process.env.FEE_ECON_GITHUB_TOKEN = TOKEN;
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ACCESS_TOKEN", "GH_ENTERPRISE_TOKEN"]) delete process.env[key];
  }
});

test("all reads use the frozen dedicated PAT and original endpoint, never switched environment values", async t => {
  let calls = 0;
  const snapshot = await run(t, async (url, init) => {
    calls++;
    assert.equal(url, `https://api.github.com/gists/${ID}`);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return reply();
  });
  try {
    process.env.FEE_ECON_GIST_ID = "f".repeat(32);
    process.env.FEE_ECON_GITHUB_TOKEN = "github_pat_" + "SYNTHETIC_DIFFERENT_TOKEN_".repeat(3);
    await snapshot.checkCurrent();
    assert.equal(calls, 4);
  } finally {
    process.env.FEE_ECON_GIST_ID = ID;
    process.env.FEE_ECON_GITHUB_TOKEN = TOKEN;
    snapshot.cleanup();
  }
});

for (const status of [401, 403, 429]) test(`publication recheck HTTP ${status} stops without anonymous fallback or changing the snapshot`, async t => {
  let calls = 0;
  const snapshot = await run(t, async (url, init) => {
    assert.equal(url, `https://api.github.com/gists/${ID}`);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return ++calls > 2 ? reply({ message: TOKEN }, '"etag"', status) : reply();
  });
  try {
    await rejected(snapshot.checkCurrent(), status === 401 ? "SOURCE_AUTH" : status === 403 ? "SOURCE_FORBIDDEN" : "SOURCE_HTTP");
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope());
  } finally { snapshot.cleanup(); }
});

test("redirect location and remote error body cannot disclose the dedicated PAT", async t => {
  let calls = 0;
  const error = await run(t, async (url, init) => {
    calls++;
    assert.equal(url, `https://api.github.com/gists/${ID}`);
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return new Response(TOKEN, { status: 302, headers: { location: `https://attacker.invalid/${TOKEN}` } });
  }).catch(error => error);
  assert.equal(calls, 1);
  assert.equal(sourceFailureCode(error), "SOURCE_REDIRECT");
  assert.equal(JSON.stringify(error).includes(TOKEN), false);
  assert.equal(String(error).includes(TOKEN), false);
  assert.equal(error.stack.includes(TOKEN), false);
});

test("duplicate and escaped-duplicate envelope keys are refused", async t => {
  for (const extra of ['"enc":false,', '"v":4,', '"\\u0065nc":false,']) {
    const body = fixture(), raw = "{" + extra + envelope().slice(1);
    body.files[NAME].content = raw; body.files[NAME].size = Buffer.byteLength(raw);
    await rejected(run(t, async () => reply(body)), "SOURCE_ENVELOPE");
  }
});
test("substantial valid base64 stays within the body/file bounds", async t => {
  const body = fixture(), raw = JSON.stringify({ enc: true, v: 3, data: Buffer.alloc(500_000).toString("base64") });
  body.files[NAME].content = raw; body.files[NAME].size = Buffer.byteLength(raw);
  const snapshot = await run(t, async () => reply(body));
  assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), raw); snapshot.cleanup();
});
test("replaced temporary directory cannot redirect cleanup outside the created directory", async t => {
  const snapshot = await run(t, async () => reply()), directory = path.dirname(snapshot.sourcePath);
  const moved = directory + "-moved", unrelated = makeRoot();
  t.after(() => fs.rmSync(unrelated, { recursive: true, force: true }));
  const sentinel = path.join(unrelated, "encrypted-source.json");
  fs.writeFileSync(sentinel, "SYNTHETIC-SENTINEL"); fs.renameSync(directory, moved); fs.symlinkSync(unrelated, directory);
  assert.throws(() => snapshot.cleanup(), error => error.code === "SOURCE_STORAGE");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "SYNTHETIC-SENTINEL");
  fs.unlinkSync(directory); fs.renameSync(moved, directory); snapshot.cleanup();
});
