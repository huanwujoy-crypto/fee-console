import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { buildFeeCalculationReceipt } from "./fee-receipt-core.mjs";
import { convertEncryptedV3Copy } from "./fee-econ-v3-copy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START = "/* fee-ledger-edit-guard:start */";
const END = "/* fee-ledger-edit-guard:end */";
const NOW = Date.parse("2026-09-01T01:00:00Z");
const FIVE_MINUTES = 5 * 60 * 1000;
const plain = value => JSON.parse(JSON.stringify(value));
// Local, read-only cross-worktree preview. CI must test its own checked-out UI.
const uiFile = process.env.FEE_LEDGER_TEST_INDEX || path.join(root, "index.html");
if (process.env.GITHUB_ACTIONS === "true" && process.env.FEE_LEDGER_TEST_INDEX)
  throw new Error("external UI preview is local-only");
assert.ok(path.isAbsolute(uiFile), "the optional synthetic UI preview path must be absolute");
const ledger = () => ({
  v: 4,
  updatedAt: "2026-09-01T00:00:00Z",
  settings: {
    start: "2026-08-01", openingAt: "2026-07-31", mgmt: 2, carry: 20,
    who: "Synthetic test owner", fx: { USD: 1, HKD: 0.1282 }
  },
  accounts: [
    { id: "schwab", name: "Schwab-HK", opening: 60_000 },
    { id: "webull", name: "Webull", opening: 40_000 }
  ],
  months: [],
  fees: []
});
const snapshot = (over = {}) => ({
  revision: "fixture-revision-1", content: "fixture-encrypted-content-1", db: ledger(), ...over
});
const legacyLedger = () => {
  const raw = ledger(); raw.v = 3;
  Object.assign(raw.settings.fx, { CNY: 0.14, EUR: 1.09, SGD: 0.745, GBP: 1.27, JPY: 0.0065 });
  raw.fees = [{ id: "fixture-legacy-empty", type: "exp", date: "2026-08-01", amount: "", ccy: "USD", fx: "", deduct: true, note: "" }];
  return raw;
};

function extractBlock(html, start = START, end = END) {
  const starts = html.split(start).length - 1, ends = html.split(end).length - 1;
  if (starts === 0 && ends === 0) return null;
  assert.equal(starts, 1, `exactly one ${start} is required`);
  assert.equal(ends, 1, `exactly one ${end} is required`);
  const from = html.indexOf(start) + start.length, to = html.indexOf(end);
  assert.ok(to > from, "guard markers must be in order");
  return html.slice(from, to);
}

function loadGuard(html) {
  const block = extractBlock(html);
  if (block === null) {
    // Stage 1 is a separate scripts-only PR.  A wholly absent implementation
    // is allowed, but a partial/unmarked migration must never silently pass.
    assert.equal(html.includes("feeLedgerEditGuard"), false,
      "the ledger guard must not be introduced outside its contract markers");
    return null;
  }
  const context = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone,
    console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(block, context, { filename: "index-fee-ledger-edit-guard.js" });
  const guard = context.feeLedgerEditGuard;
  assert.ok(guard && typeof guard === "object", "the inline guard must expose its pure API");
  for (const name of [
    "canonical", "validateLedger", "diffLedger", "sameSnapshot", "createSession",
    "begin", "lock", "touch", "isEditable", "change", "review", "prepareCommit",
    "setPendingContent", "markUnknown", "acceptReadback", "clear"
  ]) assert.equal(typeof guard[name], "function", `missing guard API: ${name}`);
  return { guard, context };
}

function editing(g, source = snapshot()) {
  return g.begin(g.createSession(), source, NOW);
}
function changed(g, source = snapshot()) {
  return g.change(editing(g, source), draft => { draft.settings.mgmt = 2.1; }, NOW + 1000);
}
function reviewed(g, source = snapshot(), reason = "更正管理费率") {
  return g.review(changed(g, source), reason, NOW + 2000);
}
function prepared(g, source = snapshot()) {
  return g.prepareCommit(reviewed(g, source), source, {
    now: NOW + 3000, id: "fixture-edit-1", at: "2026-09-01T01:00:03Z"
  });
}
function bound(g, source = snapshot()) {
  return g.setPendingContent(prepared(g, source), "fixture-encrypted-write-1");
}

// This is a synthetic browser, not a connection to a browser profile.  All
// localStorage, timers and fetches below are in-memory fixtures.  No real Gist,
// token, private ledger, filesystem browser store or outbound network is used.
async function browserHarness(html, { stored = null, legacy = false } = {}) {
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)?.[1];
  const boot = inline?.indexOf("/* ============ 启动 ============ */");
  assert.ok(boot > 0, "the main inline script must have an explicit startup boundary");
  const build = /name="fee-console-build" content="([^"]+)"/.exec(html)?.[1];
  const committed = legacy ? legacyLedger() : ledger();
  const data = {
    updatedAt: "2026-08-02T21:00:00Z",
    daily: [{ d: "2026-08-01", schwab: 60_000, webull: 40_000 }, { d: "2026-08-02", schwab: 60_100, webull: 40_100 }],
    flowsAuto: [], flowsUnresolved: [],
    status: { asOf: "2026-08-02", provisional: false, calibrated: true, unresolvedCount: 0 }
  };
  const rawKey = new Uint8Array(32).fill(7);
  const key = await crypto.webcrypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  const seal = async (db, version = 4) => {
    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(db))
    ));
    const bytes = new Uint8Array(iv.length + ciphertext.length); bytes.set(iv); bytes.set(ciphertext, iv.length);
    return JSON.stringify({ enc: true, v: version, data: Buffer.from(bytes).toString("base64") });
  };
  const initialContent = await seal(committed, legacy ? 3 : 4);
  let receiptEconomic = committed;
  if (legacy) {
    const copy = JSON.parse(convertEncryptedV3Copy(Buffer.from(initialContent), Buffer.from(rawKey), { policyId: "fee-console.legacy-empty-expense.v1" }));
    const encrypted = Buffer.from(copy.data, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(rawKey), encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    receiptEconomic = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]));
  }
  data.feeCalculationReceipt = buildFeeCalculationReceipt({ data, economicInput: receiptEconomic });
  const store = new Map([
    ["feeConsole.gh.token", "fixture-manager-token"], ["feeConsole.gh.gist", "fixture-gist"],
    ["feeConsole.key", Buffer.from(rawKey).toString("base64url")],
    ["feeConsole.v3.db", JSON.stringify(committed)], ["feeConsole.v3.daily", JSON.stringify(data)]
  ]);
  if (stored) for (const [name, value] of stored) store.set(name, value);
  const requests = [], timers = new Map(), docListeners = new Map(), winListeners = new Map(), bodyListeners = new Map();
  let timerId = 0;
  const add = (map, event, callback) => map.set(event, [...(map.get(event) || []), callback]);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, dataset: {}, style: {}, innerHTML: "", textContent: id === "btnRefresh" ? "刷新" : "",
        value: "", disabled: false, checked: false, open: false,
        classList: {
          add: (...names) => names.forEach(name => classes.add(name)),
          remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name),
          toggle(name, force) { const wanted = force ?? !classes.has(name); wanted ? classes.add(name) : classes.delete(name); return wanted; }
        },
        querySelectorAll: () => [], querySelector: selector => element(id + " " + selector), setAttribute() {}, removeAttribute() {},
        addEventListener() {}, select() {}, closest: () => null
      });
    }
    return elements.get(id);
  };
  const document = {
    visibilityState: "visible", body: { addEventListener: (event, fn) => add(bodyListeners, event, fn) },
    getElementById: element,
    querySelector: selector => selector === 'meta[name="fee-console-build"]' ? { content: build } : null,
    querySelectorAll: () => [], addEventListener: (event, fn) => add(docListeners, event, fn)
  };
  const remote = { revision: "fixture-revision-1", content: initialContent };
  const network = { loseWriteResponse: false, rejectWrite: false, corruptReadbackAfterWrite: false,
    failGistRead: false, missingGistFile: false, failDaily: false, invalidDaily: false };
  const readGates = new Map();
  const pauseNextRead = kind => {
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    readGates.set(kind, { entered, released });
    return { entered: enteredPromise, release };
  };
  const passReadGate = async kind => {
    const gate = readGates.get(kind); readGates.delete(kind);
    if (gate) { gate.entered(); await gate.released; }
  };
  let encryptionGate = null;
  let decryptionGate = null;
  const pauseNextEncryption = () => {
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    encryptionGate = { entered, released };
    return { entered: enteredPromise, release };
  };
  const pauseNextDecryption = () => {
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    decryptionGate = { entered, released };
    return { entered: enteredPromise, release };
  };
  const pageCrypto = {
    getRandomValues: value => crypto.webcrypto.getRandomValues(value), randomUUID: () => crypto.randomUUID(),
    subtle: {
      importKey: (...args) => crypto.webcrypto.subtle.importKey(...args),
      async digest(...args) { await passReadGate("digest"); return crypto.webcrypto.subtle.digest(...args); },
      async decrypt(...args) {
        const gate = decryptionGate; decryptionGate = null;
        if (gate) { gate.entered(); await gate.released; }
        return crypto.webcrypto.subtle.decrypt(...args);
      },
      async encrypt(...args) {
        const gate = encryptionGate; encryptionGate = null;
        if (gate) { gate.entered(); await gate.released; }
        return crypto.webcrypto.subtle.encrypt(...args);
      }
    }
  };
  const location = {
    href: "https://fixture.invalid/fee-console/", origin: "https://fixture.invalid",
    pathname: "/fee-console/", search: "", hash: "", reload() {}
  };
  const fetch = async (input, options = {}) => {
    const url = String(input), method = String(options.method || "GET").toUpperCase();
    requests.push({ url, method });
    const ok = body => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => typeof body === "string" ? body : JSON.stringify(body) });
    if (url.includes("api.github.com/gists/fixture-gist")) {
      if (method === "GET" && network.failGistRead) throw new Error("fixture source unavailable");
      if (method === "PATCH") {
        if (network.rejectWrite) return { ok: false, status: 403, json: async () => ({ message: "fixture rejected" }) };
        remote.content = JSON.parse(options.body).files["fee-console-db.json"].content;
        remote.revision = "fixture-revision-2";
        if (network.loseWriteResponse) throw new Error("fixture lost acknowledgement");
      } else assert.equal(method, "GET", "test reached an unexpected economic write method");
      const readContent = method === "GET" && remote.revision === "fixture-revision-2" && network.corruptReadbackAfterWrite
        ? "fixture-corrupt-readback" : remote.content;
      const result = ok({ id: "fixture-gist", history: [{ version: remote.revision }], files: network.missingGistFile ? {} : { "fee-console-db.json": { content: readContent, truncated: false } } });
      if (method === "GET") await passReadGate("gist");
      return result;
    }
    if (url.includes("api.github.com/gists?")) {
      assert.equal(method, "GET"); return ok([{ id: "fixture-gist", files: { "fee-console-db.json": {} } }]);
    }
    if (/^(?:data\.json|https:\/\/fixture\.invalid\/fee-console\/data\.json)(?:\?|$)/.test(url)) {
      if (network.failDaily) throw new Error("fixture daily unavailable");
      const result = ok(structuredClone(network.invalidDaily ? { invalid: true } : data));
      await passReadGate("daily"); return result;
    }
    if (url.startsWith("https://fixture.invalid/fee-console/")) return ok(html);
    throw new Error(`unmocked network request: ${method} ${url}`);
  };
  const sandbox = {
    crypto: pageCrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, structuredClone, URL, URLSearchParams,
    atob: text => Buffer.from(text, "base64").toString("binary"), btoa: text => Buffer.from(text, "binary").toString("base64"),
    console: { log() {}, warn() {}, error() {} }, document, location, fetch,
    navigator: { userAgent: "Synthetic iPhone Safari", standalone: false },
    history: { replaceState() {} },
    localStorage: {
      getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key)
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    DOMParser: class { parseFromString() { return { querySelector: () => ({ content: build }) }; } }
  };
  for (const [, id] of html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) sandbox[id] = element(id);
  sandbox.window = { addEventListener: (event, fn) => add(winListeners, event, fn) };
  const context = vm.createContext(sandbox);
  vm.runInContext(inline.slice(0, boot), context, { filename: "index-ledger-browser-fixture.js" });
  const run = source => vm.runInContext(source, context);
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };
  const emit = async (target, event, extra = {}) => {
    const listeners = target === "document" ? docListeners : target === "body" ? bodyListeners : winListeners;
    for (const listener of listeners.get(event) || []) await listener({ type: event, ...extra });
    await settle();
  };
  return { context, run, element, document, store, requests, remote, network, seal, emit, settle, data, committed, pauseNextEncryption, pauseNextDecryption, pauseNextRead,
    writes: () => requests.filter(request => request.method !== "GET") };
}

test("stage-one contract allows complete absence but rejects partial or unmarked editor code", () => {
  assert.equal(loadGuard("<!doctype html><html><body>pre-migration shell</body></html>"), null);
  assert.throws(() => loadGuard(`${START}\n`));
  assert.throws(() => loadGuard(`${END}\n`));
  assert.throws(() => loadGuard("globalThis.feeLedgerEditGuard = {};"));
  assert.throws(() => loadGuard(`${START}${END}${START}${END}`));
});

test("the future index-only ledger editor satisfies the frozen pure guard contract", async t => {
  const html = fs.readFileSync(uiFile, "utf8");
  const loaded = loadGuard(html);
  if (!loaded) return;
  const { guard: g, context } = loaded;

  await t.test("reload starts locked without a draft, pending write or restored edit authorization", () => {
    const session = g.createSession();
    assert.equal(session.mode, "locked");
    for (const key of ["draft", "base", "review", "pending"]) assert.equal(session[key], null);
    assert.equal(g.isEditable(session, NOW), false);
    assert.throws(() => g.change(session, d => { d.settings.mgmt = 0; }, NOW));
    assert.throws(() => g.review(session, "改费率", NOW));
  });

  await t.test("unlock requires a complete valid cloud snapshot", () => {
    for (const invalid of [null, {}, snapshot({ revision: "" }), snapshot({ content: "" }), snapshot({ db: null }),
      snapshot({ envelopeVersion: 3 }), snapshot({ db: { ...ledger(), v: 3 } })]) {
      assert.throws(() => editing(g, invalid));
    }
    assert.equal(editing(g).mode, "editing");
  });

  await t.test("edits are isolated copies; committed data and base snapshot remain byte-identical", () => {
    const source = snapshot(), before = JSON.stringify(source), session = changed(g, source);
    assert.equal(session.draft.settings.mgmt, 2.1);
    assert.equal(session.base.db.settings.mgmt, 2);
    assert.equal(JSON.stringify(source), before);
    assert.notEqual(session.draft, source.db);
    assert.notEqual(session.draft.settings, source.db.settings);
  });

  await t.test("cancel removes the draft without changing the committed ledger", () => {
    const source = snapshot(), before = JSON.stringify(source);
    const next = g.clear(changed(g, source));
    assert.equal(next.mode, "locked");
    assert.equal(next.draft, null);
    assert.equal(next.pending, null);
    assert.equal(JSON.stringify(source), before);
  });

  await t.test("invalid text, missing, non-finite and negative amounts cannot silently become zero", () => {
    const source = snapshot(), before = JSON.stringify(source);
    for (const value of ["", " ", "2oops", null, undefined, NaN, Infinity, -1]) {
      const candidate = g.change(editing(g, source), d => { d.accounts[0].opening = value; }, NOW + 1);
      assert.throws(() => g.review(candidate, "检查输入", NOW + 2), `invalid opening ${String(value)}`);
      assert.equal(candidate.draft.accounts[0].opening, value,
        "validation must not repair invalid input into a different ledger value");
      assert.equal(JSON.stringify(source), before);
    }
    const explicitZero = g.change(editing(g), d => { d.accounts[0].opening = 0; }, NOW + 1);
    assert.doesNotThrow(() => g.review(explicitZero, "明确归零", NOW + 2));
  });

  await t.test("strict ledger validation rejects impossible dates, duplicate identities and bad references", () => {
    for (const mutate of [
      d => { d.settings.start = "2026-02-30"; },
      d => { d.settings.mgmt = "2oops"; },
      d => { d.settings.mgmt = 2.12345; },
      d => { d.settings.carry = Infinity; },
      d => { d.settings.carry = "20.00001"; },
      d => { d.settings.fx.HKD = 0; },
      d => { d.accounts[1].id = "schwab"; },
      d => { d.accounts[0].id = "unknown-account"; },
      d => { d.months = [{ ym: "2026-13", flows: [] }]; },
      d => { d.months = [{ ym: "2026-08", flows: [{ id: "x", src: "", date: "2026-08-32", acct: "schwab", amount: 10, note: "test" }] }]; },
      d => { d.months = [{ ym: "2026-08", flows: [{ id: "x", src: "", date: "2026-08-03", acct: "unknown", amount: 10, note: "test" }] }]; },
      d => { d.fees = [{ id: "x", date: "2026-08-03", amount: 20, ccy: "USD", fx: "", note: "one" }, { id: "x", date: "2026-08-04", amount: 30, ccy: "USD", fx: "", note: "two" }]; }
    ]) {
      const candidate = ledger(); mutate(candidate);
      assert.throws(() => g.validateLedger(candidate));
    }
    assert.equal(g.validateLedger(ledger()), true);
  });

  await t.test("idle timeout removes write authority while preserving the draft", () => {
    const session = changed(g), last = session.lastActivity;
    assert.equal(g.isEditable(session, last + FIVE_MINUTES - 1), true);
    assert.equal(g.isEditable(session, last + FIVE_MINUTES), false);
    assert.equal(g.isEditable(session, last - 1), false, "backwards time must not extend editing");
    assert.throws(() => g.change(session, d => { d.settings.mgmt = 0; }, last + FIVE_MINUTES));
    assert.throws(() => g.review(session, "超时修改", last + FIVE_MINUTES));
    assert.equal(session.draft.settings.mgmt, 2.1);
  });

  await t.test("background lock preserves draft/base, invalidates review and requires explicit unlock", () => {
    const session = reviewed(g), locked = g.lock(session);
    assert.equal(locked.mode, "locked");
    assert.equal(locked.review, null);
    assert.equal(locked.draft.settings.mgmt, 2.1);
    assert.deepEqual(plain(locked.base), plain(session.base));
    assert.equal(g.isEditable(locked, NOW + 3000), false);
    const touched = g.touch(locked, NOW + 3000);
    assert.equal(g.isEditable(touched, NOW + 3000), false,
      "a background/resume event must never silently unlock");
    const resumed = g.begin(locked, snapshot(), NOW + 4000);
    assert.equal(resumed.mode, "editing");
    assert.equal(resumed.draft.settings.mgmt, 2.1);
    assert.equal(resumed.review, null);
  });

  await t.test("reopening a preserved draft fails on a changed remote revision or content", () => {
    const locked = g.lock(changed(g));
    assert.throws(() => g.begin(locked, snapshot({ revision: "fixture-revision-2" }), NOW + 4000));
    assert.throws(() => g.begin(locked, snapshot({ content: "fixture-reencrypted-content" }), NOW + 4000));
    assert.equal(locked.draft.settings.mgmt, 2.1);
    const remote = ledger(); remote.settings.mgmt = 2.3;
    const conflicts = plain(g.diffLedger(remote, locked.draft));
    assert.ok(conflicts.some(item => item.before === 2.3 && item.after === 2.1),
      "a rejected conflict must remain inspectable as remote-to-draft differences");
  });

  await t.test("review requires an actual change and a short, meaningful reason", () => {
    assert.throws(() => g.review(editing(g), "没有改动", NOW + 1));
    for (const reason of ["", "  ", "A", "x".repeat(301)]) {
      assert.throws(() => g.review(changed(g), reason, NOW + 2000));
    }
    const next = reviewed(g, snapshot(), "  更正  ");
    assert.equal(next.mode, "review");
    assert.ok(next.review);
    const changes = plain(g.diffLedger(ledger(), next.draft));
    assert.ok(changes.length > 0);
    assert.ok(changes.some(item => item.before === 2 && item.after === 2.1));
  });

  await t.test("any modification after review requires a new review", () => {
    const state = g.change(reviewed(g), d => { d.settings.mgmt = 2.2; }, NOW + 2500);
    assert.equal(state.review, null);
    assert.throws(() => g.prepareCommit(state, snapshot(), {
      now: NOW + 3000, id: "fixture-edit-1", at: "2026-09-01T01:00:03Z"
    }));
  });

  await t.test("save cannot skip review or overwrite a newer/changed cloud snapshot", () => {
    const options = { now: NOW + 3000, id: "fixture-edit-1", at: "2026-09-01T01:00:03Z" };
    assert.throws(() => g.prepareCommit(changed(g), snapshot(), options));
    for (const remote of [snapshot({ revision: "fixture-revision-2" }), snapshot({ content: "fixture-new-content" })]) {
      assert.throws(() => g.prepareCommit(reviewed(g), remote, options));
    }
    assert.equal(g.sameSnapshot(snapshot(), snapshot()), true);
    assert.equal(g.sameSnapshot(snapshot(), snapshot({ revision: "fixture-revision-2" })), false);
    assert.equal(g.sameSnapshot(snapshot(), snapshot({ content: "fixture-new-content" })), false);
  });

  await t.test("prepared save contains a new audited draft and blocks a second submit", () => {
    const source = snapshot(), before = JSON.stringify(source), state = prepared(g, source);
    assert.equal(state.mode, "saving");
    assert.equal(state.pending.id, "fixture-edit-1");
    assert.equal(state.pending.content, null);
    assert.equal(state.pending.db.settings.mgmt, 2.1);
    assert.equal(JSON.stringify(source), before);
    assert.ok(JSON.stringify(state.pending.db).includes("更正管理费率"), "a stored audit reason is required");
    assert.throws(() => g.prepareCommit(state, source, {
      now: NOW + 3500, id: "fixture-edit-2", at: "2026-09-01T01:00:04Z"
    }));
    assert.throws(() => g.change(state, d => { d.settings.mgmt = 0; }, NOW + 3500));
  });

  await t.test("the append-only audit remains an exact prefix and is not an editable draft field", () => {
    const originalAudit = [{
      id: "fixture-earlier-edit", at: "2026-08-31T12:00:00Z", reason: "合成旧记录",
      baseRevision: "fixture-revision-0", changes: [{ field: "settings.who", before: "Before", after: "Synthetic test owner" }]
    }];
    const source = snapshot({ db: { ...ledger(), editAudit: originalAudit } });
    const saved = prepared(g, source).pending.db;
    assert.deepEqual(plain(saved.editAudit.slice(0, originalAudit.length)), originalAudit);
    assert.equal(saved.editAudit.length, originalAudit.length + 1);
    assert.deepEqual(source.db.editAudit, originalAudit, "pre-existing audit must not be mutated by save preparation");
    assert.throws(() => g.prepareCommit(reviewed(g, source), source, {
      now: NOW + 3000, id: "fixture-earlier-edit", at: "2026-09-01T01:00:03Z"
    }), "a new change cannot reuse an existing audit id");
    for (const mutate of [
      d => { d.editAudit = []; d.settings.mgmt = 2.1; },
      d => { d.editAudit[0].reason = "替换旧记录"; d.settings.mgmt = 2.1; },
      d => { d.editAudit.push({ id: "injected" }); d.settings.mgmt = 2.1; }
    ]) {
      assert.throws(() => {
        const draft = g.change(editing(g, source), mutate, NOW + 1000);
        const review = g.review(draft, "检查篡改", NOW + 2000);
        g.prepareCommit(review, source, { now: NOW + 3000, id: "fixture-edit-2", at: "2026-09-01T01:00:03Z" });
      }, "modifying audit history must fail no later than the final write gate");
    }
  });

  await t.test("the outgoing encrypted payload must be bound once before verification", () => {
    const state = prepared(g);
    assert.throws(() => g.setPendingContent(state, ""));
    assert.throws(() => g.setPendingContent(g.createSession(), "cipher"));
    const next = g.setPendingContent(state, "fixture-encrypted-write-1");
    assert.equal(next.pending.content, "fixture-encrypted-write-1");
    assert.throws(() => g.setPendingContent(next, "fixture-different-payload"));
  });

  await t.test("network-unknown preserves the pending write but disallows editing, clearing or retry", () => {
    const state = g.markUnknown(bound(g));
    assert.equal(state.mode, "unknown");
    assert.ok(state.pending);
    assert.equal(g.isEditable(state, NOW + 4000), false);
    assert.throws(() => g.clear(state));
    assert.throws(() => g.change(state, d => { d.settings.mgmt = 0; }, NOW + 4000));
    assert.throws(() => g.prepareCommit(state, snapshot(), {
      now: NOW + 4000, id: "fixture-retry", at: "2026-09-01T01:00:04Z"
    }));
    const locked = g.lock(state);
    assert.equal(locked.mode, "unknown");
    assert.equal(locked.pending.content, state.pending.content);
  });

  await t.test("write response alone is insufficient; exact bytes and decoded ledger must match readback", () => {
    const state = g.markUnknown(bound(g));
    assert.throws(() => g.acceptReadback(state, snapshot({
      revision: "fixture-revision-2", content: "wrong-content", db: plain(state.pending.db)
    })));
    assert.throws(() => g.acceptReadback(state, snapshot({
      revision: "fixture-revision-2", content: state.pending.content, db: ledger()
    })));
    assert.throws(() => g.acceptReadback(g.createSession(), snapshot()));
    const next = g.acceptReadback(state, snapshot({
      revision: "fixture-revision-2", content: state.pending.content, db: plain(state.pending.db)
    }));
    assert.equal(next.mode, "locked");
    for (const key of ["draft", "review", "pending"]) assert.equal(next[key], null);
  });

  await t.test("the old calculation receipt becomes invalid after a verified economic edit", async () => {
    const block = extractBlock(html, "/* fee-receipt-consumer:start */", "/* fee-receipt-consumer:end */");
    assert.ok(block, "the existing receipt consumer remains required");
    vm.runInContext(block, context, { filename: "index-receipt-consumer-for-ledger-guard.js" });
    const data = {
      daily: [{ d: "2026-08-01", schwab: 60_000, webull: 40_000 }, { d: "2026-08-02", schwab: 60_100, webull: 40_100 }],
      flowsAuto: [], flowsUnresolved: [],
      status: { asOf: "2026-08-02", provisional: false, calibrated: true, unresolvedCount: 0 }
    };
    const economicInput = ledger(), receipt = buildFeeCalculationReceipt({ data, economicInput });
    assert.equal((await context.feeReceiptUiModel({ receipt, data, economicInput })).ok, true);
    const savedLedger = plain(bound(g).pending.db);
    const rejected = plain(await context.feeReceiptUiModel({ receipt, data, economicInput: savedLedger }));
    assert.deepEqual(rejected, { ok: false, reason: "calculation receipt pending" });
    assert.equal(data.daily.length, 2, "asset data must remain available when only fee results are invalidated");
  });
});

test("the real inline page only writes a synthetic Gist after reviewed save and readback", async t => {
  const html = fs.readFileSync(uiFile, "utf8");
  if (!loadGuard(html)) return;

  await t.test("read-only viewers can still change the historical year without ledger editing", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    h.run('setCfg(K.tok, "")');
    const selector = h.element("monthHistoryYear"); selector.value = "2025";
    await h.emit("body", "change", { target: selector });
    assert.equal(h.run("_monthHistoryYear"), "2025");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("render, connect, refresh and resume never POST/PATCH even with manager credentials", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("render()");
    h.run("autosave()");
    await h.run("pullAll(true,{skipShell:true})");
    await h.run('connect("fixture-manager-token")');
    await h.run("manualRefresh()");
    h.document.visibilityState = "hidden";
    await h.emit("document", "visibilitychange");
    h.document.visibilityState = "visible";
    await h.emit("document", "visibilitychange");
    await h.emit("window", "pageshow", { persisted: true });
    await h.emit("window", "online");
    await h.run("render()");
    assert.deepEqual(h.writes(), []);
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.match(h.element("ledgerBar").innerHTML, /只读查看.*编辑已锁定/);
  });

  await t.test("the central GitHub write gate rejects all unreviewed mutations before fetch", async () => {
    const h = await browserHarness(html);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      await assert.rejects(() => h.run(`ghApi("/gists/fixture-gist",{method:${JSON.stringify(method)},body:"{}"})`));
    }
    await assert.rejects(() => h.run("ghPush()"));
    assert.deepEqual(h.writes(), []);
  });

  await t.test("read refresh cannot overwrite a differing local or cloud ledger", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    const newer = ledger(); newer.updatedAt = "2026-09-02T00:00:00Z"; newer.accounts[0].opening = 61_000;
    h.remote.content = await h.seal(newer); h.remote.revision = "fixture-newer-revision";
    const remoteBefore = h.remote.content;
    await h.run("pullAll(true,{skipShell:true})");
    await h.run("render()");
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.equal(h.remote.content, remoteBefore);
    assert.deepEqual(h.writes(), []);
    assert.match(h.element("ledgerBar").innerHTML, /不同|差异|复核/);
  });

  await t.test("a legacy v3 read never rewrites an existing local ledger or creates a new Gist", async () => {
    const h = await browserHarness(html), original = h.store.get("feeConsole.v3.db");
    const legacy = { ...ledger(), v: 3 }; legacy.settings.mgmt = 2.3;
    const envelope = JSON.parse(await h.seal(legacy)); envelope.v = 3;
    h.remote.content = JSON.stringify(envelope); h.remote.revision = "fixture-legacy-revision";
    const cloudBytes = h.remote.content;
    await h.run("pullAll(true,{skipShell:true})");
    assert.equal(h.store.get("feeConsole.v3.db"), original);
    assert.equal(h.remote.content, cloudBytes);
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.deepEqual(h.writes(), []);
  });

  await t.test("an outer-v3/inner-v4 mismatch remains readable-only and cannot unlock an editor", async () => {
    const h = await browserHarness(html);
    const envelope = JSON.parse(h.remote.content); envelope.v = 3;
    h.remote.content = JSON.stringify(envelope);
    await h.run("beginLedgerEdit()");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft"), null);
    await assert.rejects(() => h.run("ghPush()"));
    assert.deepEqual(h.writes(), []);
  });

  await t.test("a verified baseline permits a subsequent legitimate cloud update without writing", async () => {
    const h = await browserHarness(html);
    await h.run("pullAll(true,{skipShell:true})");
    const newer = ledger(); newer.updatedAt = "2026-09-02T00:00:00Z"; newer.settings.mgmt = 2.3;
    h.remote.content = await h.seal(newer); h.remote.revision = "fixture-legitimate-revision";
    await h.run("pullAll(true,{skipShell:true})");
    await h.run("render()");
    assert.equal(h.run("DB.settings.mgmt"), 2.3,
      "a local ledger still matching its last verified cloud baseline must accept a fresh cloud read");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.deepEqual(h.writes(), []);
    assert.match(h.element("monthsBox").innerHTML, /计算回执待更新/,
      "new economic input must not reuse the old receipt");
  });

  await t.test("an unreadable saved draft blocks editing and is never overwritten or deleted", async () => {
    const h = await browserHarness(html);
    const broken = '{"enc":true,"v":1,"data":"fixture-invalid-cipher"}';
    h.context.__brokenDraft = broken;
    h.run("setCfg(DRAFT_KEY,__brokenDraft)");
    await h.run("restoreDraft()");
    await h.run("beginLedgerEdit()");
    await h.run("persistDraft()");
    assert.equal(h.run("canEdit()"), false);
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft"), null);
    assert.equal(h.run("cfg(DRAFT_KEY)"), broken,
      "an unknown draft is recoverable evidence, not an empty draft to replace");
    assert.deepEqual(h.writes(), []);
  });

  await t.test("immediate editing waits for delayed draft decryption instead of replacing the old draft", async () => {
    const previous = await browserHarness(html);
    await previous.run("beginLedgerEdit()");
    previous.run("changeDraft(d=>{d.settings.mgmt=2.1;})"); await previous.run("_draftWrite");
    const encryptedDraft = previous.run("cfg(DRAFT_KEY)");
    const h = await browserHarness(html, { stored: new Map(previous.store) });
    h.remote.content = previous.remote.content; h.remote.revision = previous.remote.revision;
    const gate = h.pauseNextDecryption();
    const restoring = h.run("restoreDraft()");
    await gate.entered;
    const beginning = h.run("beginLedgerEdit()");
    await h.settle();
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft"), null, "a second editor cannot appear while restoration is unresolved");
    assert.equal(h.run("cfg(DRAFT_KEY)"), encryptedDraft);
    assert.deepEqual(h.writes(), []);
    gate.release();
    await Promise.all([restoring, beginning]); await h.run("_draftWrite");
    assert.equal(h.run("EDIT.mode"), "editing");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    assert.equal(h.run("DB.settings.mgmt"), 2);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("real input handlers are inert while locked; unlocked input changes only the draft", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    const input = h.element("sMgmt"); input.value = "3.5";
    await h.emit("body", "input", { target: input });
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.equal(h.run("EDIT.draft"), null);
    await h.run("beginLedgerEdit()");
    assert.equal(h.run("EDIT.mode"), "editing");
    input.value = "2.1";
    await h.emit("body", "input", { target: input });
    await h.run("_draftWrite");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), "2.1");
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.deepEqual(h.writes(), []);
    const storedDraft = h.run("cfg(DRAFT_KEY)");
    assert.equal(JSON.parse(storedDraft).enc, true);
    assert.doesNotMatch(storedDraft, /Synthetic test owner|fixture-manager-token|"settings"/,
      "local draft persistence must be encrypted, not plaintext economic records");
  });

  await t.test("background locks a real draft; resuming must re-read the remote and preserve a conflict", async () => {
    const h = await browserHarness(html);
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})");
    await h.run("_draftWrite");
    h.document.visibilityState = "hidden";
    await h.emit("document", "visibilitychange");
    await h.run("_draftWrite");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    h.document.visibilityState = "visible";
    const remote = ledger(); remote.settings.mgmt = 2.3;
    h.remote.content = await h.seal(remote); h.remote.revision = "fixture-new-revision";
    const readCount = h.requests.length;
    await h.run("beginLedgerEdit()");
    assert.ok(h.requests.length > readCount, "resume must perform a fresh cloud read");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    assert.equal(h.run("EDIT.review"), null);
    assert.ok(h.run("_ledgerConflict.length") > 0);
    await h.run("render()");
    assert.match(h.element("ledgerBar").innerHTML, /冲突/);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("cancel and discard UI actions do not modify the committed ledger or cloud", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})");
    await h.run("_draftWrite");
    await h.emit("body", "click", { target: h.element("ledgerDiscard") });
    h.element("cfmCancel").onclick();
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    await h.emit("body", "click", { target: h.element("ledgerDiscard") });
    h.element("cfmOk").onclick();
    await h.run("_draftWrite");
    assert.equal(h.run("EDIT.draft"), null);
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("an empty number in the real form stays invalid rather than writing zero", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    const input = h.element("sMgmt"); input.value = "";
    await h.emit("body", "input", { target: input });
    await h.run("_draftWrite");
    h.run("showLedgerReview()"); h.element("ledgerReason").value = "检查空输入";
    h.run("confirmLedgerReview()");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), "");
    assert.equal(h.run("EDIT.review"), null);
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("remote change between review and final save preserves the draft without PATCH", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})"); await h.run("_draftWrite");
    h.run("showLedgerReview()"); h.element("ledgerReason").value = "合成冲突检查";
    h.run("confirmLedgerReview()");
    const newer = ledger(); newer.settings.mgmt = 2.3;
    h.remote.content = await h.seal(newer); h.remote.revision = "fixture-concurrent-revision";
    await h.run("_cfmCb()"); await h.run("render()");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    assert.equal(h.run("EDIT.review"), null);
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.match(h.element("ledgerBar").innerHTML, /冲突/);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("background during encryption sends no PATCH and can safely resume the preserved draft", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})"); await h.run("_draftWrite");
    h.run("showLedgerReview()"); h.element("ledgerReason").value = "合成后台检查";
    h.run("confirmLedgerReview()");
    const gate = h.pauseNextEncryption();
    const saving = h.run("_cfmCb()");
    await gate.entered;
    h.document.visibilityState = "hidden";
    await h.emit("document", "visibilitychange");
    gate.release();
    await saving; await h.run("_draftWrite");
    assert.deepEqual(h.writes(), []);
    assert.equal(h.run("JSON.stringify(DB)"), original);
    assert.equal(h.run("EDIT.draft.settings.mgmt"), 2.1);
    assert.equal(h.run("EDIT.pending"), null,
      "a request that was never sent must not strand the draft in an unrecoverable unknown state");
    h.document.visibilityState = "visible";
    await h.run("beginLedgerEdit()");
    assert.equal(h.run("EDIT.mode"), "editing");
    assert.equal(h.run("EDIT.review"), null);
    assert.deepEqual(h.writes(), []);
  });

  await t.test("one reviewed save yields one PATCH, verified cloud readback and a pending old receipt", async () => {
    const h = await browserHarness(html);
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})");
    await h.run("_draftWrite");
    h.run("showLedgerReview()");
    h.element("ledgerReason").value = "合成测试更正";
    h.run("confirmLedgerReview()");
    assert.equal(h.run("EDIT.mode"), "review");
    assert.deepEqual(h.writes(), [], "review is not yet a write");
    assert.equal(typeof h.run("_cfmCb"), "function", "the final explicit confirmation must be present");
    await h.run("_cfmCb()");
    await h.run("render()");
    assert.equal(h.writes().length, 1);
    assert.equal(h.writes()[0].method, "PATCH");
    assert.equal(h.run("DB.settings.mgmt"), 2.1);
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("EDIT.pending"), null);
    assert.equal(h.run("DB.editAudit.at(-1).reason"), "合成测试更正");
    assert.match(h.element("monthsBox").innerHTML, /计算回执待更新/);
    assert.equal(h.data.daily.length, 2);
  });

  await t.test("lost write acknowledgement enters unknown; checking only GETs and accepts exact readback", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})");
    await h.run("_draftWrite");
    h.run("showLedgerReview()"); h.element("ledgerReason").value = "合成网络检查";
    h.run("confirmLedgerReview()"); h.network.loseWriteResponse = true;
    await h.run("_cfmCb()");
    assert.equal(h.run("EDIT.mode"), "unknown");
    assert.equal(h.run("JSON.stringify(DB)"), original, "uncertain write must not be presented as a successful local commit");
    assert.equal(h.writes().length, 1);
    await h.run("checkLedgerOutcome()");
    assert.equal(h.writes().length, 1, "outcome check must never resend the PATCH");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.run("DB.settings.mgmt"), 2.1);
  });

  await t.test("a successful PATCH with unverifiable readback remains unknown until a clean GET", async () => {
    const h = await browserHarness(html), original = h.run("JSON.stringify(DB)");
    await h.run("beginLedgerEdit()");
    h.run("changeDraft(d=>{d.settings.mgmt=2.1;})"); await h.run("_draftWrite");
    h.run("showLedgerReview()"); h.element("ledgerReason").value = "合成读回检查";
    h.run("confirmLedgerReview()"); h.network.corruptReadbackAfterWrite = true;
    await h.run("_cfmCb()");
    assert.equal(h.run("EDIT.mode"), "unknown");
    assert.equal(h.run("JSON.stringify(DB)"), original);
    await h.run("checkLedgerOutcome()");
    assert.equal(h.run("EDIT.mode"), "unknown");
    assert.equal(h.writes().length, 1);
    h.network.corruptReadbackAfterWrite = false;
    await h.run("checkLedgerOutcome()");
    assert.equal(h.run("EDIT.mode"), "locked");
    assert.equal(h.writes().length, 1);
  });
});

test("raw-v3 source lifecycle never restores stale verified fees after invalidation", async t => {
  const html = fs.readFileSync(uiFile, "utf8");
  const block = extractBlock(html, "/* fee-legacy-policy:start */", "/* fee-legacy-policy:end */");
  if (block === null) {
    // The support PR precedes the index-only PR. Once either marker or lifecycle
    // implementation appears, absence/partial deployment must fail this test.
    assert.equal(/feeLegacyPolicy|_receiptSource|_sourceEpoch/.test(html), false,
      "legacy lifecycle must not exist without the complete shared-policy markers");
    return;
  }
  assert.ok(loadGuard(html));
  for (const name of ["invalidateReceiptSource", "acceptReceiptSource", "ghReadSnapshot", "pullAll", "render"])
    assert.match(html, new RegExp("function " + name + "\\("), "missing lifecycle function " + name);

  const pending = async h => {
    await h.run("render()"); await h.settle();
    assert.match(h.element("monthsBox").innerHTML, /计算回执待更新/);
    assert.match(h.element("balBox").innerHTML, /计算回执待更新/);
    assert.doesNotMatch(h.element("balBox").innerHTML, /应付费用|累计管理费/,
      "pending status must hide the last verified fee figures");
    assert.deepEqual(h.writes(), []);
  };
  const verified = async h => {
    await h.run("render()"); await h.settle();
    assert.equal(h.run('_receiptSource.state'), "verified");
    assert.doesNotMatch(h.element("monthsBox").innerHTML, /计算回执待更新/);
    assert.match(h.element("balBox").innerHTML, /应付费用/);
    assert.deepEqual(h.writes(), []);
  };
  const ready = async () => {
    const h = await browserHarness(html, { legacy: true });
    await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    return h;
  };

  await t.test("cached raw v3 is pending until a real synthetic source read and never becomes an editable v4 source", async () => {
    const h = await browserHarness(html, { legacy: true }), rawBefore = h.store.get("feeConsole.v3.db"), cloudBefore = h.remote.content;
    await pending(h);
    assert.equal(h.run("DB.v"), 4, "only the read-only display projection has v4 shape");
    await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    assert.equal(h.run("DB.fees.length"), 0);
    assert.equal(h.store.get("feeConsole.v3.db"), rawBefore);
    await h.run("beginLedgerEdit()");
    assert.equal(h.run("EDIT.mode"), "locked"); assert.equal(h.run("EDIT.draft"), null);
    await assert.rejects(() => h.run("ghPush()"));
    assert.equal(h.remote.content, cloudBefore); assert.deepEqual(h.writes(), []);
  });

  await t.test("source HTTP failure and missing source file hide previous fees while preserving raw records", async () => {
    for (const flag of ["failGistRead", "missingGistFile"]) {
      const h = await ready(), before = h.store.get("feeConsole.v3.db");
      h.network[flag] = true;
      await h.run("pullAll(true,{skipShell:true})"); await pending(h);
      assert.equal(h.run("_receiptSource.state"), "unverified");
      assert.equal(h.store.get("feeConsole.v3.db"), before);
      h.network[flag] = false;
      await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    }
  });

  await t.test("daily failure or invalid daily shape cannot validate old fee results using a new source read", async () => {
    for (const flag of ["failDaily", "invalidDaily"]) {
      const h = await ready(); h.network[flag] = true;
      await h.run("pullAll(true,{skipShell:true})"); await pending(h);
      assert.equal(h.run("_receiptSource.state"), "unverified");
      h.network[flag] = false;
      await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    }
  });

  await t.test("a now-nonempty expense or new unknown field fails before the old projection can be reused", async () => {
    for (const mutate of [raw => { raw.fees[0].amount = 25; }, raw => { raw.fees[0].amount = "25.00"; },
      raw => { raw.fees[0].unknown = true; }, raw => { raw.fees[0].deduct = "true"; }]) {
      const h = await ready(), before = h.store.get("feeConsole.v3.db"), changed = legacyLedger(); mutate(changed);
      h.remote.content = await h.seal(changed, 3); h.remote.revision = "fixture-changed-legacy";
      await h.run("pullAll(true,{skipShell:true})"); await pending(h);
      assert.equal(h.store.get("feeConsole.v3.db"), before);
      assert.equal(h.run("_receiptSource.state"), "unverified");
    }
  });

  await t.test("same plaintext with new encrypted envelope bytes invalidates the old source-bound receipt", async () => {
    const h = await ready(); h.remote.content = await h.seal(legacyLedger(), 3);
    h.remote.revision = "fixture-reencrypted-source";
    await h.run("pullAll(true,{skipShell:true})"); await pending(h);
    assert.equal(h.run("_receiptSource.state"), "verified", "a readable source is not proof that its old receipt matches");
  });

  await t.test("manual refresh failure keeps old fee results hidden", async () => {
    const h = await ready(); h.network.failDaily = true;
    await h.run("manualRefresh()"); await pending(h);
    assert.equal(h.run("_manualRefreshing"), false);
    assert.equal(h.element("btnRefresh").disabled, false);
  });

  await t.test("an older successful source response cannot refill fees after a newer refresh failed", async () => {
    const h = await ready(), gate = h.pauseNextRead("gist");
    const older = h.run("pullAll(true,{skipShell:true})"); await gate.entered;
    h.network.failGistRead = true;
    await h.run("pullAll(true,{skipShell:true})"); await pending(h);
    gate.release(); await older; await pending(h);
    assert.equal(h.run("_receiptSource.state"), "unverified");
  });

  await t.test("an older failing source response cannot clear a newer successful refresh", async () => {
    const h = await ready(), original = h.remote.content;
    h.remote.content = "fixture-invalid-envelope";
    const gate = h.pauseNextRead("gist"), older = h.run("pullAll(true,{skipShell:true})"); await gate.entered;
    h.remote.content = original;
    await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    gate.release(); await older; await verified(h);
  });

  await t.test("an older daily response cannot revive fees after a newer daily failure", async () => {
    const h = await ready(), gate = h.pauseNextRead("daily");
    const older = h.run("pullAll(true,{skipShell:true})"); await gate.entered;
    h.network.failDaily = true;
    await h.run("pullAll(true,{skipShell:true})"); await pending(h);
    gate.release(); await older; await pending(h);
  });

  await t.test("a delayed verified render cannot overwrite a newer pending render", async () => {
    const h = await ready(), gate = h.pauseNextRead("digest");
    const older = h.run("render()"); await gate.entered;
    h.network.failGistRead = true;
    await h.run("pullAll(true,{skipShell:true})"); await pending(h);
    gate.release(); await older; await pending(h);
  });

  await t.test("Gist or key change during a source read rejects its stale result without changing the new identity", async () => {
    for (const field of ["gid", "key"]) {
      const h = await ready(), gate = h.pauseNextRead("gist");
      const older = h.run("pullAll(true,{skipShell:true})"); await gate.entered;
      h.run(`setCfg(K.${field},"fixture-changed-identity")`);
      gate.release(); await older; await pending(h);
      assert.equal(h.run(`cfg(K.${field})`), "fixture-changed-identity");
      assert.equal(h.run("_receiptSource.state"), "unverified");
    }
  });

  await t.test("removing all source access and switching storage identity hide fees even without a successful next read", async () => {
    const h = await ready();
    h.run('setCfg(K.gid,"");setCfg(K.key,"");setCfg(K.tok,"")');
    await h.run("pullAll(true,{skipShell:true})"); await pending(h);
    const switched = await ready(); switched.network.failGistRead = true;
    switched.run('setCfg(K.gid,"fixture-gist-switched")');
    await switched.emit("window", "storage", { key: "feeConsole.gh.gist" });
    await pending(switched);
    assert.equal(switched.run("EDIT.mode"), "locked");
  });

  await t.test("background and pagehide invalidate the source; resume needs a fresh successful read", async () => {
    const h = await ready(); h.document.visibilityState = "hidden";
    await h.emit("document", "visibilitychange"); await pending(h);
    h.document.visibilityState = "visible"; h.network.failGistRead = true;
    await h.emit("document", "visibilitychange"); await pending(h);
    h.network.failGistRead = false;
    await h.run("pullAll(true,{skipShell:true})"); await verified(h);
    await h.emit("window", "pagehide"); await pending(h);
  });
});
