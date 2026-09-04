// Synthetic DOM contract tests, not a browser or phone acceptance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TREND_METHOD, simulateEtfTrend, projectEtfTrend, projectOpenEtfTrend } from './xuan-ib-etf-trend.mjs';
import { mountEtfTrend, clearEtfTrend, MAX_ETF_DISPLAY_BYTES, ETF_SEEN_DATE } from './xuan-ib-etf-trend-view.mjs';

class Node {
  constructor(tag = '') { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.id = ''; this.className = ''; this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.text = ''; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n instanceof Document; }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#FRAGMENT') { this.append(...[...node.children]); continue; }
      node.remove(); node.parentNode = this; this.children.push(node);
    }
  }
  prepend(node) { node.remove(); node.parentNode = this; this.children.unshift(node); }
  remove() { if (this.parentNode) { const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null;
    this.children = []; this.text = ''; this.append(...nodes); }
  set textContent(text) { this.replaceChildren(); this.text = String(text); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() { for (const callback of this.listeners.click || []) await callback(); }
  cloneNode(deep) { const node = new Node(this.tagName); node.id = this.id; node.className = this.className; node.text = this.text;
    if (deep) node.append(...this.children.map(child => child.cloneNode(true))); return node; }
  get innerHTML() { return this.text + this.children.map(child => child.outerHTML).join(''); }
  get outerHTML() { return `<${this.tagName.toLowerCase()}${this.id ? ` id="${this.id}"` : ''}>${this.innerHTML}</${this.tagName.toLowerCase()}>`; }
}
class RawHtml extends Node {
  constructor(html) { super('#raw'); this.html = html; }
  get outerHTML() { return this.html; }
  get textContent() { return this.html; }
  cloneNode() { return new RawHtml(this.html); }
}
class Template extends Node {
  constructor() { super('template'); this.content = new Node('#fragment'); }
  set innerHTML(html) { this.content.replaceChildren(new RawHtml(html)); }
}
class Document extends Node {
  constructor() { super('#document'); this.body = new Node('body'); this.append(this.body); }
  createElement(tag) { return tag === 'template' ? new Template() : new Node(tag); }
  all() { const nodes = []; const walk = node => { nodes.push(node); node.children.forEach(walk); }; walk(this); return nodes; }
  getElementById(id) { return this.all().find(node => node.id === id) || null; }
  querySelectorAll(selector) {
    assert.equal(selector, '.pane.p5');
    return this.all().filter(node => ['pane', 'p5'].every(name => node.className.split(/\s+/).includes(name)));
  }
}
function documentFixture() {
  const doc = new Document(), tabs = doc.createElement('div'), pane = doc.createElement('section');
  tabs.className = 'tabs'; doc.body.append(tabs); pane.className = 'pane p5'; tabs.append(pane);
  const original = doc.createElement('article'); original.id = 'original-policy'; original.textContent = 'SYNTHETIC ORIGINAL POLICY';
  const history = doc.createElement('article'); history.id = 'original-baseline'; history.textContent = 'SYNTHETIC BASELINE';
  pane.append(original, history); return { doc, pane, original, history };
}
function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial)), reads = [], writes = [];
  return { values, reads, writes, getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push([key, value]); values.set(key, String(value)); }, removeItem(key) { values.delete(key); } };
}
const now = new Date('2026-09-04T02:00:00Z');
const baseUrl = 'https://example.test/fee-console/xuan-ib/';
const ETF_DEVICE_KEY='xuan-etf:private-key:v2'; // Legacy storage must never be read.
const key = () => randomBytes(32).toString('base64url');
const panel = doc => doc.getElementById('xuan-etf-private-panel');
const privateHtml = doc => panel(doc)?.innerHTML.includes('xuan-etf-trend-v2') || false;
function payload(through = 2) {
  const days = Array.from({ length: through }, (_, i) => {
    const date = `2020-09-0${i + 1}`;
    return { date, actualUsd: 1234567 + i * 1000, actualComplete: true, flowsComplete: true,
      flows: [], sourceRef: 'synthetic-only', quotes: Object.fromEntries(['CSPX', 'EXUS', 'EIMI', 'USSC']
        .map(s => [s, { status: 'close', usd: 100 + i, date, source: 'synthetic' }])) };
  });
  const result = simulateEtfTrend({ methodId: TREND_METHOD, startDate: '2020-09-01', frozenDate: '2020-09-04',
    initialUsd: 1234567, reserveUsd: 240000, days });
  return { projection: projectEtfTrend(result), result };
}
async function response(secret, through = 2) {
  const envelope = projectOpenEtfTrend(payload(through).result, { now });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  return { ok: true, headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const options = (f, storage, fetchFn, extra = {}) => ({ doc: f.doc, storage, baseUrl, fetchFn, now, ...extra });
function pauseNextDigest() {
  const subtle = globalThis.crypto.subtle, descriptor = Object.getOwnPropertyDescriptor(subtle, 'digest');
  const digest = subtle.digest.bind(subtle), entered = deferred(), release = deferred(); let first = true;
  Object.defineProperty(subtle, 'digest', { configurable: true, value: async (...args) => {
    const result = await digest(...args);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  } });
  return { entered: entered.promise, release: () => release.resolve(), restore() {
    release.resolve(); if (descriptor) Object.defineProperty(subtle, 'digest', descriptor); else delete subtle.digest;
  } };
}

test('open comparison loads without access code and never reads or changes either stored key', async () => {
  for(const legacy of [false,true]){
    const f=documentFixture(),storage=storageFixture(legacy ? {'feeConsole.key':'DO-NOT-READ',[ETF_DEVICE_KEY]:'DO-NOT-READ'} : {});let calls=0;
    await mountEtfTrend(options(f,storage,async()=>{calls++;return response(key());}));
    assert.equal(calls,1);assert.equal(privateHtml(f.doc),true);
    assert.ok(storage.reads.every(k=>k===ETF_SEEN_DATE));assert.ok(storage.writes.every(([k])=>k===ETF_SEEN_DATE));
    assert.equal(f.doc.all().some(n=>n.tagName==='INPUT'||n.tagName==='BUTTON'),false);
    assert.equal(storage.values.get(ETF_DEVICE_KEY),legacy?'DO-NOT-READ':undefined);
  }
});

test('validated open data renders published summary amounts and stores only source high-water date', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret); let request;
  await mountEtfTrend(options(f, storage, async (...args) => { request = args; return received; }));
  assert.equal(privateHtml(f.doc), true);
  assert.ok(panel(f.doc).innerHTML.includes('1,235,567'));
  assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-02');
  assert.deepEqual(storage.writes, [[ETF_SEEN_DATE, '2020-09-02']]);
  assert.equal(new URL(request[0]).origin, new URL(baseUrl).origin);
  assert.equal(request[1].credentials, 'omit'); assert.equal(request[1].redirect, 'error'); assert.equal(request[1].cache, 'no-store');
  assert.equal(request[0].includes(secret), false);
});

test('original ETF policy/history is folded, not deleted or duplicated', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  const mount = () => mountEtfTrend(options(f, storage, async () => received));
  await mount(); await mount();
  const folded = f.doc.getElementById('xuan-etf-original-history');
  assert.equal(folded.tagName, 'DETAILS'); assert.notEqual(folded.attributes.open, '');
  assert.equal(f.original.parentNode, folded); assert.equal(f.history.parentNode, folded);
  assert.equal(folded.children[0].tagName, 'SUMMARY');
  assert.equal(f.doc.all().filter(n => n.id === 'xuan-etf-original-history').length, 1);
});

test('network failure and oversized declared data render no comparison DOM', async () => {
  for (const failMode of ['network', 'large', 'unavailable']) {
    const f = documentFixture(), storage = storageFixture({ [ETF_DEVICE_KEY]: key() }); let bodyRead = false;
    await mountEtfTrend(options(f, storage, async () => {
      if (failMode === 'network') throw new Error('synthetic failure');
      return { ok: failMode !== 'unavailable', headers: { get: () => String(MAX_ETF_DISPLAY_BYTES) },
        arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0); } };
    }));
    assert.equal(privateHtml(f.doc), false); assert.equal(bodyRead, false);
    assert.equal(storage.values.has(ETF_SEEN_DATE), false);
  }
});

test('public fetch parser rejects duplicate JSON, invalid UTF-8, excess bytes and unknown nested fields', async () => {
  const valid = projectOpenEtfTrend(payload().result, { now });
  const nested = structuredClone(valid); nested.latestBalances.usd.sourceRef = 'PRIVATE-SENTINEL';
  const canonical = JSON.stringify(valid);
  for (const bytes of [
    new TextEncoder().encode(canonical.replace('{', '{"schemaVersion":3,')),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array(MAX_ETF_DISPLAY_BYTES),
    new TextEncoder().encode(JSON.stringify(nested))
  ]) {
    const f = documentFixture(), storage = storageFixture();
    await mountEtfTrend(options(f, storage, async () => ({ok:true, headers:{get:()=>null},
      arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)})));
    assert.equal(privateHtml(f.doc), false);
    assert.equal(panel(f.doc).textContent, 'ABC 比较暂不可用，请稍后刷新；其它报告保留。');
    assert.ok(!panel(f.doc).textContent.includes('PRIVATE-SENTINEL'));
    assert.deepEqual(storage.writes, []);
    assert.equal(f.original.parentNode, f.pane);
  }
});

test('stale external sequence never renders or writes a date', async () => {
  const f = documentFixture(), storage = storageFixture(), secret = key(), wait = deferred(); let current = true;
  const mounting = mountEtfTrend(options(f, storage, () => wait.promise, { keyOverride: secret, isCurrent: () => current }));
  current = false; wait.resolve(await response(secret)); await mounting;
  assert.equal(privateHtml(f.doc), false); assert.deepEqual(storage.writes, []);
});

test('stale failing request cannot replace content to a newer panel', async () => {
  const f = documentFixture(), storage = storageFixture(), wait = deferred(); let current = true;
  const mounting = mountEtfTrend(options(f, storage, () => wait.promise, { keyOverride: key(), isCurrent: () => current }));
  const before = panel(f.doc).innerHTML; current = false;
  wait.reject(new Error('late synthetic failure')); await mounting;
  assert.equal(panel(f.doc).innerHTML, before);
});

test('prior device date rejects an older source and retains high-water mark', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret, [ETF_SEEN_DATE]: '2020-09-03' });
  const received = await response(secret, 2);
  await mountEtfTrend(options(f, storage, async () => received));
  assert.equal(privateHtml(f.doc), false); assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
  assert.deepEqual(storage.writes, []);
});

test('same-date verified source can be loaded again', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret, [ETF_SEEN_DATE]: '2020-09-02' });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  assert.equal(privateHtml(f.doc), true);
});

test('identical display data polling preserves verified nodes, visible date and details state', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  const originalNode = panel(f.doc).children[0], detail = f.doc.createElement('details');
  detail.open = true; detail.append(f.doc.createElement('summary')); panel(f.doc).append(detail);
  const before = panel(f.doc).innerHTML;
  for (let i = 0; i < 2; i++) {
    const wait = deferred(), mounting = mountEtfTrend(options(f, storage, () => wait.promise));
    assert.equal(panel(f.doc).innerHTML, before);
    assert.equal(panel(f.doc).children[0], originalNode);
    assert.ok(panel(f.doc).innerHTML.includes('2020-09-02'));
    wait.resolve(received); await mounting;
    assert.equal(panel(f.doc).children[0], originalNode);
    assert.equal(detail.isConnected, true); assert.equal(detail.open, true);
    assert.equal(panel(f.doc).innerHTML, before);
  }
});

test('different verified display data replaces the prior panel content normally', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  await mountEtfTrend(options(f, storage, async () => response(secret, 2)));
  const previous = panel(f.doc).children[0], detail = f.doc.createElement('details');
  detail.open = true; panel(f.doc).append(detail);
  await mountEtfTrend(options(f, storage, async () => response(secret, 3)));
  assert.notEqual(panel(f.doc).children[0], previous); assert.equal(previous.isConnected, false);
  assert.equal(detail.isConnected, false); assert.equal(privateHtml(f.doc), true);
  assert.ok(panel(f.doc).innerHTML.includes('2020-09-03'));
});

test('refresh failure clears previously verified plaintext and permits the same data to recover', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  for (const fail of [async () => { throw new Error('synthetic unavailable'); }, async () => ({ok:true,headers:{get:()=>null},arrayBuffer:async()=>new TextEncoder().encode('{}').buffer})]) {
    await mountEtfTrend(options(f, storage, async () => received));
    const previous = panel(f.doc).children[0];
    await mountEtfTrend(options(f, storage, fail));
    assert.equal(privateHtml(f.doc), false); assert.equal(previous.isConnected, false);
    assert.equal(panel(f.doc).innerHTML.includes('1,235,567'), false);
    await mountEtfTrend(options(f, storage, async () => received));
    assert.equal(privateHtml(f.doc), true); assert.notEqual(panel(f.doc).children[0], previous);
  }
});

test('clear invalidates the displayed fingerprint so same-data remount renders again', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  const previous = panel(f.doc).children[0];
  clearEtfTrend(f.doc); assert.equal(privateHtml(f.doc), false);
  await mountEtfTrend(options(f, storage, async () => received));
  assert.equal(privateHtml(f.doc), true); assert.notEqual(panel(f.doc).children[0], previous);
});

test('display fingerprint is bound to panel identity, not only the document', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  const previous = panel(f.doc); previous.remove();
  await mountEtfTrend(options(f, storage, async () => received));
  assert.notEqual(panel(f.doc), previous); assert.equal(privateHtml(f.doc), true);
});

test('same-data refresh rechecks cross-document high-water after asynchronous hashing', async () => {
  const f = documentFixture(), other = documentFixture(), secret = key();
  const storage = storageFixture({ [ETF_DEVICE_KEY]: secret }), received = await response(secret, 2);
  const newest = await response(secret, 3);
  await mountEtfTrend(options(f, storage, async () => received));
  const pause = pauseNextDigest();
  try {
    const mounting = mountEtfTrend(options(f, storage, async () => received));
    await pause.entered; assert.equal(privateHtml(f.doc), true);
    await mountEtfTrend(options(other, storage, async () => newest));
    pause.release(); await mounting;
    assert.equal(privateHtml(f.doc), false); assert.equal(privateHtml(other.doc), true);
    assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
  } finally { pause.restore(); }
});

test('clear during hashing prevents same-data refresh from restoring comparison content', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  const pause = pauseNextDigest();
  try {
    const mounting = mountEtfTrend(options(f, storage, async () => received));
    await pause.entered; clearEtfTrend(f.doc); const cleared = panel(f.doc).innerHTML;
    pause.release(); await mounting;
    assert.equal(panel(f.doc).innerHTML, cleared); assert.equal(privateHtml(f.doc), false);
  } finally { pause.restore(); }
});

test('a newer mount during hashing is not overwritten or cleared by the stale refresh', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret, 2), newest = await response(secret, 3);
  await mountEtfTrend(options(f, storage, async () => received));
  const pause = pauseNextDigest();
  try {
    const mounting = mountEtfTrend(options(f, storage, async () => received));
    await pause.entered; await mountEtfTrend(options(f, storage, async () => newest));
    const newestNode = panel(f.doc).children[0];
    pause.release(); await mounting;
    assert.equal(panel(f.doc).children[0], newestNode);
    assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03'); assert.equal(privateHtml(f.doc), true);
  } finally { pause.restore(); }
});

test('clear removes all plaintext without deleting original history or device key', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret });
  const received = await response(secret);
  await mountEtfTrend(options(f, storage, async () => received));
  clearEtfTrend(f.doc);
  assert.equal(privateHtml(f.doc), false);
  assert.equal(panel(f.doc).innerHTML.includes('1,235,567'), false);
  assert.equal(storage.values.get(ETF_DEVICE_KEY), secret);
  assert.equal(f.original.isConnected, true); assert.equal(f.history.isConnected, true);
});

test('clear also invalidates in-flight work so plaintext cannot reappear', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret }), wait = deferred();
  const mounting = mountEtfTrend(options(f, storage, () => wait.promise));
  clearEtfTrend(f.doc); const cleared = panel(f.doc).innerHTML;
  wait.resolve(await response(secret)); await mounting;
  assert.equal(panel(f.doc).innerHTML, cleared);
  assert.equal(privateHtml(f.doc), false); assert.deepEqual(storage.writes, []);
});

test('newer completed mount cannot be overwritten by older in-flight mount', async () => {
  const f = documentFixture(), secret = key(), storage = storageFixture({ [ETF_DEVICE_KEY]: secret }), wait = deferred();
  const older = mountEtfTrend(options(f, storage, () => wait.promise));
  const newest = await response(secret, 3);
  await mountEtfTrend(options(f, storage, async () => newest));
  const before = panel(f.doc).innerHTML;
  assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
  wait.resolve(await response(secret, 2)); await older;
  assert.equal(panel(f.doc).innerHTML, before);
  assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
});

test('another document advancing shared high-water date invalidates older pending source', async () => {
  const oldDoc = documentFixture(), newDoc = documentFixture(), secret = key();
  const storage = storageFixture({ [ETF_DEVICE_KEY]: secret }), wait = deferred();
  const older = mountEtfTrend(options(oldDoc, storage, () => wait.promise));
  const newest = await response(secret, 3);
  await mountEtfTrend(options(newDoc, storage, async () => newest));
  assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
  wait.resolve(await response(secret, 2)); await older;
  assert.equal(privateHtml(oldDoc.doc), false);
  assert.equal(privateHtml(newDoc.doc), true);
  assert.equal(storage.values.get(ETF_SEEN_DATE), '2020-09-03');
});

test('ambiguous or absent ETF pane is untouched and does not fetch', async () => {
  for (const count of [0, 2]) {
    const doc = new Document();
    for (let i = 0; i < count; i++) { const p = doc.createElement('section'); p.className = 'pane p5'; doc.body.append(p); }
    let calls = 0;
    await mountEtfTrend({ doc, storage: storageFixture(), baseUrl, now, fetchFn: async () => { calls++; } });
    assert.equal(calls, 0); assert.equal(panel(doc), null);
  }
});
