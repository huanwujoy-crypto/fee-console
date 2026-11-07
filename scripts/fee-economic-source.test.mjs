// Synthetic fixtures only. No real Gist, token, key, or financial input is read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from 'node:crypto';
import { fetchEconomicSnapshot, SourceFetchError, sourceFailureCode, verifyEconomicSnapshot, readEconomicSnapshotBytes,
  economicSourceDiagnosticCode, ECONOMIC_SOURCE_DIAGNOSTIC_CODES } from "./fee-economic-source.mjs";

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
const withFund=(body,raw='synthetic-encrypted-fund-placeholder')=>({...body,files:{...body.files,'fee-console-fund.json':{filename:'fee-console-fund.json',content:raw,size:Buffer.byteLength(raw),truncated:false}}});
test('existing private fund ciphertext is bound to the same Gist and two reads without another credential or endpoint',async t=>{
  let calls=0;const snap=await run(t,async url=>{assert.equal(url,'https://api.github.com/gists/'+ID);calls++;return reply(withFund(fixture(4)));});
  assert.equal(calls,2);assert.equal(snap.fundProfileStable,true);assert.equal(snap.fundProfileRaw,'synthetic-encrypted-fund-placeholder');assert.equal(snap.fundProfileMatchesGist(ID),true);assert.equal(snap.fundProfileMatchesGist('b'.repeat(32)),false);
  await snap.checkCurrent({requireFundProfile:true});assert.equal(calls,4);snap.cleanup();assert.equal(snap.fundProfileMatchesGist(ID),false);
});
test('changed or unstable optional fund ciphertext never grants a transfer exception or refreshes old evidence',async t=>{
  let calls=0;const snap=await run(t,async()=>reply(withFund(fixture(4),++calls<=2?'synthetic-first':'synthetic-changed')));
  await rejected(snap.checkCurrent({requireFundProfile:true}),'SOURCE_CHANGED');snap.cleanup();
  let n=0;const unstable=await run(t,async()=>reply(withFund(fixture(4),'synthetic-'+(++n))));assert.equal(unstable.fundProfileStable,false);assert.equal(unstable.fundProfileRaw,null);unstable.cleanup();
});
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

test('version binding exposes only a frozen digest of actual stable source, never source identifiers or credentials',async t=>{
  let calls=0;const snap=await run(t,async()=>{calls++;return reply();});
  const binding=snap.getVersionBinding();
  assert.equal(calls,2,'getting the acquired version does not claim a new remote check');
  assert.deepEqual(Object.keys(binding).sort(),['schema','sha256']);
  assert.equal(binding.schema,'fee-console.economic-source-version.v1');assert.match(binding.sha256,/^[a-f0-9]{64}$/);
  const preimage=JSON.stringify({schema:binding.schema,locator:ID,contentSha256:createHash('sha256').update(envelope()).digest('hex'),revision:'b'.repeat(40),etag:'"synthetic-etag"'});
  assert.equal(binding.sha256,createHash('sha256').update(preimage).digest('hex'));
  for(const secret of [ID,TOKEN,envelope(),'b'.repeat(40),'synthetic-etag',snap.sourcePath])assert.equal(JSON.stringify(binding).includes(secret),false);
  assert.equal(Object.isFrozen(binding),true);assert.throws(()=>{binding.sha256='0'.repeat(64);},TypeError);
  assert.equal(Object.getOwnPropertyDescriptor(snap,'getVersionBinding').enumerable,false);
  assert.equal(snap.getVersionBinding(),binding);await snap.checkCurrent();assert.equal(calls,4);assert.equal(snap.getVersionBinding(),binding);
  snap.cleanup();assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CLOSED'});
});
test('version hash preserves exact encrypted bytes and revision/opaque-tag semantics',async t=>{
  const acquire=async mutate=>run(t,async()=>{const body=fixture();let etag='"same-tag"';etag=mutate?.(body,etag)??etag;return reply(body,etag);});
  const base=await acquire(),tag=await acquire((_body,etag)=>'W/'+etag);
  assert.deepEqual(tag.getVersionBinding(),base.getVersionBinding());
  for(const mutate of [body=>{body.files[NAME].content+=' ';body.files[NAME].size++;},body=>{body.history[0].version='B'.repeat(40);},()=> '"other-tag"']){
    const changed=await acquire(mutate);assert.notEqual(changed.getVersionBinding().sha256,base.getVersionBinding().sha256);changed.cleanup();
  }
  // Locator is internally bound without exposing it in the returned structure.
  try{
    process.env.FEE_ECON_GIST_ID='c'.repeat(32);
    const other=await acquire(body=>{body.id='c'.repeat(32);});assert.notEqual(other.getVersionBinding().sha256,base.getVersionBinding().sha256);other.cleanup();
  }finally{process.env.FEE_ECON_GIST_ID=ID;}
  base.cleanup();tag.cleanup();
});
test('factory authentication and checked ciphertext access reject lookalikes without executing their methods',async t=>{
  let calls=0,forgeries=0;const snap=await run(t,async()=>{calls++;return reply();});
  assert.equal(verifyEconomicSnapshot(snap),true);
  const fake={get checkCurrent(){forgeries++;return()=>true;},get getVersionBinding(){forgeries++;return()=>({sha256:'a'.repeat(64)});}};
  for(const value of [fake,null,{},new Proxy(snap,{get(){forgeries++;return true;}})]){
    assert.equal(verifyEconomicSnapshot(value),false);assert.throws(()=>readEconomicSnapshotBytes(value),{code:'SOURCE_OPTIONS'});
  }
  assert.equal(forgeries,0);assert.throws(()=>readEconomicSnapshotBytes(snap),{code:'SOURCE_CHANGED'});assert.equal(calls,2);
  await snap.checkCurrent();const bytes=readEconomicSnapshotBytes(snap);assert.ok(Buffer.isBuffer(bytes));assert.equal(bytes.toString('utf8'),envelope());assert.equal(calls,4);
  bytes.fill(0);assert.equal(readEconomicSnapshotBytes(snap).toString('utf8'),envelope());assert.equal(fs.readFileSync(snap.sourcePath,'utf8'),envelope());
  snap.cleanup();assert.throws(()=>readEconomicSnapshotBytes(snap),{code:'SOURCE_CLOSED'});
});
test('failed current verification revokes binding permanently and never advances the acquired version',async t=>{
  let mode='same',calls=0;const snap=await run(t,async()=>{calls++;const body=fixture();if(mode==='changed')body.history[0].version='c'.repeat(40);return reply(body);});
  const before=snap.getVersionBinding();await snap.checkCurrent();mode='changed';await rejected(snap.checkCurrent(),'SOURCE_CHANGED');
  assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});assert.throws(()=>readEconomicSnapshotBytes(snap),{code:'SOURCE_CHANGED'});
  mode='same';assert.equal(await snap.checkCurrent(),true,'legacy checkCurrent remains compatible');
  assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});assert.equal(calls,8);assert.equal(fs.readFileSync(snap.sourcePath,'utf8'),envelope());
  assert.match(before.sha256,/^[a-f0-9]{64}$/);snap.cleanup();
});
test('local ciphertext or mode tampering prevents binding and remains revoked even if restored',async t=>{
  for(const kind of ['content','mode'])await t.test(kind,async t=>{
    let calls=0;const snap=await run(t,async()=>{calls++;return reply();});await snap.checkCurrent();
    if(kind==='content')fs.appendFileSync(snap.sourcePath,' ');else fs.chmodSync(snap.sourcePath,0o644);
    assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_STORAGE'});assert.equal(calls,4);
    if(kind==='content')fs.writeFileSync(snap.sourcePath,envelope());else fs.chmodSync(snap.sourcePath,0o600);
    assert.throws(()=>readEconomicSnapshotBytes(snap),{code:'SOURCE_CHANGED'});snap.cleanup();
  });
});
test('in-flight current verification cannot be bypassed by reading the old version',async t=>{
  let calls=0,release,entered;const paused=new Promise(r=>{entered=r;}),wait=new Promise(r=>{release=r;});
  const snap=await run(t,async()=>{if(++calls===3){entered();await wait;}return reply();});
  const version=snap.getVersionBinding(),pending=snap.checkCurrent();await paused;
  assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});assert.throws(()=>readEconomicSnapshotBytes(snap),{code:'SOURCE_CHANGED'});assert.equal(calls,3);
  release();assert.equal(await pending,true);assert.equal(calls,4);assert.equal(snap.getVersionBinding(),version);snap.cleanup();
});
test('network or option failure revokes binding without changing original fixed failure codes',async t=>{
  for(const kind of ['network','options'])await t.test(kind,async t=>{
    let calls=0;const snap=await run(t,async()=>{if(++calls>2&&kind==='network')throw Error('PRIVATE_SYNTHETIC');return reply();},{attempts:1});
    await rejected(snap.checkCurrent(kind==='options'?{callerSuppliedDigest:'a'.repeat(64)}:{}),kind==='network'?'SOURCE_NETWORK':'SOURCE_CHANGED');
    assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});assert.equal(calls,kind==='network'?3:2);snap.cleanup();
  });
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
  assert.deepEqual(Object.keys(snapshot).sort(), ["checkCurrent", "cleanup", "envelopeVersion", "fundProfileMatchesGist", "fundProfileRaw", "fundProfileStable", "managerRecipientRaw", "sourcePath"]);
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

test("weak-marker-only differences are accepted at all three comparisons", async t => {
  for (const v of [3, 4]) for (const [from, to] of [
    ['"synthetic-opaque"', 'W/"synthetic-opaque"'],
    ['W/"synthetic-opaque"', '"synthetic-opaque"'],
  ]) for (const [stage, tags] of [
    ["initial double read", [from, to, from, from]],
    ["final double read", [from, from, from, to]],
    ["frozen versus final", [from, from, to, to]],
  ]) await t.test(`v${v} ${stage}: ${from} to ${to}`, async t => {
    let calls = 0, snapshot;
    try {
      snapshot = await run(t, async () => {
        assert.ok(calls < tags.length, "no additional request for a marker difference");
        return reply(fixture(v), tags[calls++]);
      });
      assert.equal(await snapshot.checkCurrent(), true);
      assert.equal(calls, 4);
      assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope(v));
    } finally { snapshot?.cleanup(); }
    assert.equal(fs.existsSync(snapshot.sourcePath), false);
  });
});

test("weak-marker compatibility never permits revision, opaque tag or envelope changes", async t => {
  const from = 'W/"synthetic-opaque"', to = '"synthetic-opaque"';
  const cases = [
    ["revision", body => { body.history[0].version = "c".repeat(40); }, to],
    ["revision letter case", body => { body.history[0].version = "B".repeat(40); }, to],
    ["opaque tag", () => {}, '"different-opaque"'],
    ["opaque letter case", () => {}, '"Synthetic-opaque"'],
    ["opaque percent encoding", () => {}, '"synthetic%2Dopaque"'],
    ["opaque backslash", () => {}, '"synthetic\\-opaque"'],
    ["envelope whitespace", body => { body.files[NAME].content += " "; }, to],
    ["envelope key order", body => {
      const value = JSON.parse(body.files[NAME].content);
      body.files[NAME].content = JSON.stringify({ v: value.v, data: value.data, enc: value.enc }, null, 2) + "\n";
    }, to],
    ["sealed ciphertext", body => {
      const value = JSON.parse(body.files[NAME].content);
      value.data = Buffer.alloc(40, 8).toString("base64");
      body.files[NAME].content = JSON.stringify(value, null, 2) + "\n";
    }, to],
  ];
  for (const [name, mutate, changedTag] of cases) for (const [stage, changedReads] of [
    ["initial double read", [false, true]],
    ["final double read", [false, false, false, true]],
    ["frozen versus final", [false, false, true, true]],
  ]) await t.test(`${stage} rejects ${name}`, async t => {
    const tempRoot = makeRoot(); t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    let calls = 0, snapshot;
    const acquire = fetchEconomicSnapshot({ tempRoot, timeoutMs: 50, attempts: 2, fetchImpl: async () => {
      assert.ok(calls < changedReads.length, "SOURCE_CHANGED is not retried");
      const changed = changedReads[calls++], body = fixture(4);
      if (changed) mutate(body);
      body.files[NAME].size = Buffer.byteLength(body.files[NAME].content);
      return reply(body, changed ? changedTag : from);
    } });
    try {
      if (stage === "initial double read") await rejected(acquire, "SOURCE_CHANGED");
      else {
        snapshot = await acquire;
        await rejected(snapshot.checkCurrent(), "SOURCE_CHANGED");
        assert.equal(fs.readFileSync(snapshot.sourcePath, "utf8"), envelope(4), "frozen source is never overwritten");
      }
      assert.equal(calls, changedReads.length);
    } finally { snapshot?.cleanup(); }
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  });
});

test("missing or malformed ETags still fail before comparison without retry", async t => {
  for (const etag of [null, "", '""', 'W/""', 'w/"synthetic-opaque"', 'W/W/"synthetic-opaque"',
    'W/ "synthetic-opaque"', '"one", "two"', '"two words"', '"bad\u0001tag"', '"' + "a".repeat(513) + '"']) {
    for (const phase of ["initial", "final"]) await t.test(`${phase} ${JSON.stringify(etag)}`, async t => {
      let calls = 0, snapshot;
      const acquire = run(t, async () => {
        const response = reply(fixture(4), 'W/"synthetic-opaque"');
        const bad = ++calls === (phase === "initial" ? 2 : 4);
        if (bad) {
          const get = response.headers.get.bind(response.headers);
          response.headers.get = name => name === "etag" ? etag : get(name);
        }
        return response;
      });
      try {
        if (phase === "initial") await rejected(acquire, "SOURCE_ETAG");
        else { snapshot = await acquire; await rejected(snapshot.checkCurrent(), "SOURCE_ETAG"); }
        assert.equal(calls, phase === "initial" ? 2 : 4);
      } finally { snapshot?.cleanup(); }
      if (snapshot) assert.equal(fs.existsSync(snapshot.sourcePath), false);
    });
  }
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

test("malformed optional read PAT fails before any request or snapshot write", async t => {
  const tempRoot = makeRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  try {
    for (const value of ["", " ", "github_pat_short", "ghp_" + "a".repeat(40),
      "gho_" + "a".repeat(40), "Bearer " + TOKEN, TOKEN + "\n", " " + TOKEN,
      TOKEN + "\r\nX-Secret: injected", TOKEN + "\t", TOKEN + "é", TOKEN + '"',
      "github_pat_" + "a".repeat(256)]) {
      process.env.FEE_ECON_GITHUB_TOKEN = value;
      let calls = 0;
      await rejected(fetchEconomicSnapshot({ tempRoot, fetchImpl: async () => { calls++; return reply(); } }), "SOURCE_AUTH_CONFIG");
      assert.equal(calls, 0);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
    }
  } finally { process.env.FEE_ECON_GITHUB_TOKEN = TOKEN; }
});

test("anonymous secret-Gist read ignores generic GitHub credentials", async t => {
  // These synthetic decoys must never be inspected by the production helper.
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ACCESS_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
    process.env[key] = "github_pat_" + "SYNTHETIC_GENERIC_DECOY_".repeat(3);
  }
  delete process.env.FEE_ECON_GITHUB_TOKEN;
  try {
    let calls = 0;
    const snapshot = await run(t, async (url, init) => {
      calls++;
      assert.equal(url, `https://api.github.com/gists/${ID}`);
      assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "X-GitHub-Api-Version"]);
      return reply();
    });
    assert.equal(calls, 2);
    assert.equal(await snapshot.checkCurrent(), true);
    snapshot.cleanup();
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

test('optional recipient is stable metadata only; missing or changed registration never blocks ordinary fees',async t=>{
  let text='{"public":"synthetic-recipient"}';
  const snap=await run(t,async()=>{const b=fixture(4);b.files['fee-console-ratio-recipient.json']={filename:'fee-console-ratio-recipient.json',content:text,size:Buffer.byteLength(text),truncated:false};return reply(b);});
  assert.equal(snap.managerRecipientRaw,text);await snap.checkCurrent({requireManagerRecipient:true});
  text='{"public":"different-synthetic-recipient"}';await snap.checkCurrent();await rejected(snap.checkCurrent({requireManagerRecipient:true}),'SOURCE_CHANGED');snap.cleanup();
  const missing=await run(t,async()=>reply(fixture(4)));await missing.checkCurrent();await rejected(missing.checkCurrent({requireManagerRecipient:true}),'SOURCE_CHANGED');missing.cleanup();
});

test('economic diagnostics use private error identity and never inspect unknown or malicious errors',async()=>{
  let touches=0;
  const hostile={};
  for(const key of ['code','message','cause','name','stack'])Object.defineProperty(hostile,key,{get(){touches++;throw Error('SYNTHETIC_PRIVATE');}});
  const proxy=new Proxy(hostile,{get(){touches++;throw Error('SYNTHETIC_PRIVATE');},getPrototypeOf(){touches++;throw Error('SYNTHETIC_PRIVATE');},ownKeys(){touches++;throw Error('SYNTHETIC_PRIVATE');}});
  const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const value of [undefined,null,false,0,'SOURCE_HTTP',Symbol('synthetic'),hostile,proxy,revoked.proxy,
    new Error('SYNTHETIC_PRIVATE'),new SourceFetchError('SOURCE_HTTP'),Object.create(SourceFetchError.prototype)]){
    assert.equal(economicSourceDiagnosticCode(value),'UNKNOWN');
  }
  let actual;
  await assert.rejects(fetchEconomicSnapshot({notAnAllowedOption:true}),error=>{actual=error;return error.code==='SOURCE_OPTIONS';});
  assert.equal(economicSourceDiagnosticCode(actual),'SOURCE_OPTIONS');
  assert.deepEqual(Object.keys(actual).sort(),['code','name'],'diagnostic metadata is not attached to the error');
  Object.defineProperty(actual,'code',{get(){touches++;throw Error('SYNTHETIC_PRIVATE');}});
  Object.defineProperty(actual,'message',{get(){touches++;throw Error('SYNTHETIC_PRIVATE');}});
  assert.equal(economicSourceDiagnosticCode(actual),'SOURCE_OPTIONS');
  assert.equal(economicSourceDiagnosticCode(new Proxy(actual,{})),'UNKNOWN');
  assert.equal(touches,0);
  assert.equal(Object.isFrozen(ECONOMIC_SOURCE_DIAGNOSTIC_CODES),true);
  assert.equal(new Set(ECONOMIC_SOURCE_DIAGNOSTIC_CODES).size,ECONOMIC_SOURCE_DIAGNOSTIC_CODES.length);
  assert.ok(ECONOMIC_SOURCE_DIAGNOSTIC_CODES.every(value=>/^[A-Z_]+$/.test(value)));
});

test('diagnostics distinguish pair and frozen mismatches without changing rejection or reads',async t=>{
  for(const stage of ['initial-pair','recheck-pair','frozen'])for(let mask=1;mask<8;mask++)await t.test(`${stage} ${mask}`,async t=>{
    let calls=0,snapshot;
    const fetchImpl=async()=>{
      calls++;
      const changed=stage==='initial-pair'?calls===2:stage==='recheck-pair'?calls===4:calls>2;
      const body=fixture(4);let etag='"synthetic-fixed"';
      if(changed){
        if(mask&1)body.history[0].version='c'.repeat(40);
        if(mask&2){body.files[NAME].content+=' ';body.files[NAME].size++;}
        if(mask&4)etag='"synthetic-changed"';
      }
      return reply(body,etag);
    };
    const operation=stage==='initial-pair'?run(t,fetchImpl):(snapshot=await run(t,fetchImpl),snapshot.checkCurrent());
    const suffix=mask===1?'REVISION':mask===2?'BYTES':mask===4?'ETAG':'MULTIPLE';
    await assert.rejects(operation,error=>{
      assert.equal(sourceFailureCode(error),'SOURCE_CHANGED');assert.equal(error.message,'SOURCE_CHANGED');
      assert.equal(economicSourceDiagnosticCode(error),`${stage==='frozen'?'FROZEN':'PAIR'}_${suffix}`);
      assert.equal(Object.hasOwn(error,'cause'),false);return true;
    });
    assert.equal(calls,stage==='initial-pair'?2:4);
    if(snapshot){
      assert.equal(fs.readFileSync(snapshot.sourcePath,'utf8'),envelope(4));
      assert.throws(()=>snapshot.getVersionBinding(),{code:'SOURCE_CHANGED'});snapshot.cleanup();
    }
  });
});

test('diagnostics preserve transport classification, bounded retry and unknown-error provenance',async t=>{
  const cases=[
    ['auth',()=>reply({},'"synthetic"',401),'SOURCE_AUTH',1],
    ['forbidden',()=>reply({},'"synthetic"',403),'SOURCE_FORBIDDEN',1],
    ['http',()=>reply({},'"synthetic"',429),'SOURCE_HTTP',1],
    ['redirect',()=>reply({},'"synthetic"',302),'SOURCE_REDIRECT',1],
    ['network',()=>{throw Error(`SYNTHETIC_PRIVATE ${ID} ${TOKEN}`);},'SOURCE_NETWORK',2],
    ['timeout',()=>new Promise(()=>{}),'SOURCE_TIMEOUT',2],
    ['response',()=>new Response('SYNTHETIC_PRIVATE',{headers:{etag:'"synthetic"'}}),'SOURCE_RESPONSE',1],
    ['forged',()=>{throw new SourceFetchError('SOURCE_HTTP');},'SOURCE_HTTP',1],
  ];
  for(const [name,badReply,code,attempts]of cases)await t.test(name,async t=>{
    let calls=0;
    const snap=await run(t,async()=>++calls<=2?reply(fixture(4)):badReply(),{timeoutMs:10});
    await assert.rejects(snap.checkCurrent(),error=>{
      assert.equal(sourceFailureCode(error),code);assert.equal(error.message,code);
      assert.equal(economicSourceDiagnosticCode(error),name==='forged'?'UNKNOWN':code);
      assert.equal(Object.hasOwn(error,'cause'),false);return true;
    });
    assert.equal(calls,2+attempts);assert.equal(fs.readFileSync(snap.sourcePath,'utf8'),envelope(4));
    assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});snap.cleanup();
  });
});

test('diagnostics separate local directory, file, mode, bytes and IO without remote rechecks',async t=>{
  for(const kind of ['directory','file','file-mode','directory-mode','bytes','io'])await t.test(kind,async t=>{
    let calls=0;
    const snap=await run(t,async()=>{calls++;return reply(fixture(4));});
    const directory=path.dirname(snap.sourcePath),moved=directory+'-original';let restore;
    if(kind==='directory'){
      fs.renameSync(directory,moved);fs.mkdirSync(directory,{mode:0o700});
      restore=()=>{fs.rmdirSync(directory);fs.renameSync(moved,directory);};
    }else if(kind==='file'){
      fs.unlinkSync(snap.sourcePath);fs.mkdirSync(snap.sourcePath,{mode:0o700});
      restore=()=>{fs.rmdirSync(snap.sourcePath);fs.writeFileSync(snap.sourcePath,envelope(4),{mode:0o600});};
    }else if(kind==='file-mode'||kind==='directory-mode'){
      const file=kind==='file-mode'?snap.sourcePath:directory;fs.chmodSync(file,0o755);
      restore=()=>fs.chmodSync(file,kind==='file-mode'?0o600:0o700);
    }else if(kind==='bytes'){
      fs.appendFileSync(snap.sourcePath,' ');restore=()=>fs.writeFileSync(snap.sourcePath,envelope(4));
    }else{
      fs.unlinkSync(snap.sourcePath);restore=()=>fs.writeFileSync(snap.sourcePath,envelope(4),{mode:0o600});
    }
    try{
      await assert.rejects(snap.checkCurrent(),error=>{
        assert.equal(sourceFailureCode(error),'SOURCE_STORAGE');assert.equal(error.message,'SOURCE_STORAGE');
        assert.equal(economicSourceDiagnosticCode(error),'LOCAL_'+(kind.endsWith('mode')?'MODE':kind.toUpperCase()));return true;
      });
      assert.equal(calls,2);
    }finally{restore();}
    assert.throws(()=>snap.getVersionBinding(),{code:'SOURCE_CHANGED'});snap.cleanup();
    await assert.rejects(snap.checkCurrent(),error=>{
      assert.equal(sourceFailureCode(error),'SOURCE_CLOSED');assert.equal(economicSourceDiagnosticCode(error),'SOURCE_CLOSED');return true;
    });
    assert.equal(calls,2);
  });
});
