import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import {renderPublicEodSummary,qualifyRecordedPublicSummary} from './xuan-ib-public-eod-summary.mjs';



const candidateLoader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
// An action-page publication intentionally uses index.html as the candidate.
// Exercise the unchanged fixed-loader contract against the newest trusted
// non-action version in Git history. The merge base itself can now contain an
// action page after that temporary publication lands on main, so looking only
// at the merge-base copy would make every later PR fail without testing a
// loader at all. The action page remains covered by its dedicated guards.
const isFixedLoader = (html) => html.includes('<iframe id="handover"')
  && html.includes('const loaderBuild = "')
  && (html.match(/<script>/g) || []).length === 1;
const historicalLoader = () => {
  const commits = execFileSync('git', ['log', '--format=%H', '--', 'xuan-ib/index.html'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const html = execFileSync('git', ['show', `${commit}:xuan-ib/index.html`], { encoding: 'utf8' });
    if (isFixedLoader(html)) return html;
  }
  throw new Error('no trusted fixed loader exists in Git history');
};
const loader = isFixedLoader(candidateLoader) ? candidateLoader : historicalLoader();
const latestBytes = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url));
const latest = latestBytes.toString('utf8');

// Git addresses a file by the SHA-1 of "blob <byte length>\0" plus its bytes.
// Deriving it here keeps the trusted-metadata test honest against whatever the
// promotion workflow last published, instead of freezing one day's digest.
const gitBlobSha = (bytes) => crypto
  .createHash('sha1')
  .update(`blob ${bytes.length}\0`, 'utf8')
  .update(bytes)
  .digest('hex');

// The one title the loader requires of every future candidate, plus any title
// it still tolerates while previously published pages age out.
const approvedTitles = [...loader.matchAll(/"(<title>[^"]*<\/title>)"/g)].map((match) => match[1]);
const primaryDate = (html) => {
  const match = html.match(/<span class="date">(\d{4}-\d{2}-\d{2})\b/)
    || html.match(/<header>[^]*?<p>(\d{4}-\d{2}-\d{2})\s*·/i);
  assert.ok(match, 'the published handover must carry a primary data date');
  return match[1];
};
const promotion = fs.readFileSync(new URL('../.github/workflows/promote-xuan-ib-handover.yml', import.meta.url), 'utf8');
const validation = fs.readFileSync(new URL('../.github/workflows/validate-xuan-ib-handover.yml', import.meta.url), 'utf8');
const uiPrCheck = fs.readFileSync(new URL('../.github/workflows/ui-pr-check.yml', import.meta.url), 'utf8');
const policyLock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
const scriptsCheck = fs.readFileSync(new URL('../.github/workflows/scripts-check.yml', import.meta.url), 'utf8');
const metadata = JSON.parse(fs.readFileSync(new URL('../xuan-ib/latest.meta.json', import.meta.url), 'utf8'));
const appBuild = JSON.parse(fs.readFileSync(new URL('../xuan-ib/app-build.json', import.meta.url), 'utf8'));

test('the duplicate wrapper header is absent from layout while loading controls remain available', () => {
  assert.match(loader, /<header class="bar" hidden>/);
  assert.match(loader, /\.bar\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  const header = loader.match(/<header\b[^]*?<\/header>/)?.[0] || '';
  assert.match(header, /id="status"/);
  assert.match(header, /id="refresh"[^>]*hidden/);
  assert.match(loader, /<iframe id="handover"[^>]*sandbox=""/);
  assert.match(loader, /<div id="warning" role="alert" hidden>/);
  assert.match(loader, /<button id="app-update" type="button" hidden>/);
});

test('promotion commits the derived decision menu with its paired report and metadata', () => {
  assert.match(promotion, /xuan-ib-decision-menu\.mjs publish-manifest/);
  assert.match(promotion, /git add xuan-ib\/latest\.html xuan-ib\/latest\.meta\.json xuan-ib\/latest\.decisions\.json/);
  assert.match(policyLock, /xuan-ib-decision-menu\|build-xuan-decision-shortcut/);
});

const inlineScript = loader.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'the phone loader must contain one executable inline script');

test('loader schedule is an exact generated copy of the shared tested module', () => {
  const module = fs.readFileSync(new URL('./xuan-ib-report-schedule.mjs', import.meta.url), 'utf8');
  const expected = module.replace(/^export /gm,'').split('\n').map(line=>line?'        '+line:'').join('\n');
  assert.ok(loader.includes(expected), 'browser and watchdog must not drift on DST or cutover');
});

const classList = () => {
  const names = new Set();
  return {
    add: (...values) => values.forEach((value) => names.add(value)),
    remove: (...values) => values.forEach((value) => names.delete(value)),
    toggle: (value, force) => {
      if (force === undefined ? !names.has(value) : force) names.add(value);
      else names.delete(value);
    },
    contains: (value) => names.has(value),
  };
};

const response = ({json, bytes, status = 200}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => json,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});

const reportHtml = (date, edition, body = '') => `<!doctype html><html><head><title>XUAN-投资管理</title></head><body>
<!-- xuan-ib-handover:v1 -->
<span class="date">${date} 周五 · ${edition} · 美股盘前</span>
<main>${body}</main></body></html>`;

const decisionTemplate = ({interaction = 'enabled', decisions = [], receipts = []} = {}) =>
  `<template id="xuan-ib-decision-state-v1">${JSON.stringify({
    schemaVersion: 1,
    interaction,
    decisions,
    receipts,
  })}</template>`;

const awaitingDecision = (decisionId = 'D-20260830-TEST-ITEM') => ({
  decisionId,
  status: 'awaiting_user',
});

const metaFor = (html, overrides = {}) => {
  const bytes = Buffer.from(html, 'utf8');
  return {
    schemaVersion: 1,
    sourceSha: '1'.repeat(40),
    sourceCommitEpoch: 1_788_000_000,
    dataDate: primaryDate(html),
    htmlBlob: gitBlobSha(bytes),
    ...overrides,
  };
};

// Deliberately small DOM model for the parent-owned display enhancement. It
// models adoption, element identity and load ordering; it does not pretend to
// establish real-browser sandbox or iOS external-protocol behavior.
class DisplayElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.listeners = {};
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get content() { return this.getAttribute('content') || ''; }
  set content(value) { this.setAttribute('content', value); }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
  set textContent(value) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this._text = String(value);
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  adopt(ownerDocument) {
    this.ownerDocument = ownerDocument;
    for (const node of this.children) node.adopt(ownerDocument);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.adopt(this.ownerDocument);
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.adopt(this.ownerDocument);
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceWith(node) {
    const parent = this.parentElement;
    assert.ok(parent, 'replacement target must have a parent');
    const position = parent.children.indexOf(this);
    node.remove();
    node.adopt(this.ownerDocument);
    node.parentElement = parent;
    parent.children[position] = node;
    this.parentElement = null;
  }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    const attributes = [...selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
    const presentAttributes = [...selector.matchAll(/\[([\w-]+)\]/g)].map((match) => match[1]);
    const simple = selector.replace(/\[[^\]]+\]/g, '').replace(/:checked/g, '');
    const tag = simple.match(/^[a-z][a-z0-9-]*/i)?.[0];
    const classes = [...simple.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    const id = simple.match(/#([\w-]+)/)?.[1];
    return (!tag || this.tagName === tag.toUpperCase()) &&
      (!id || this.id === id) &&
      classes.every((name) => this.className.split(/\s+/).includes(name)) &&
      attributes.every(([, name, value]) => this.getAttribute(name) === value) &&
      presentAttributes.every((name) => this.hasAttribute(name)) &&
      (!selector.includes(':checked') || this.checked);
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.descendants()]);
    const parts = selector.trim().split(/\s+(?![^\[]*\])/);
    return descendants.filter((node) => {
      if (!node.matches(parts.at(-1))) return false;
      let ancestor = node.parentElement;
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class DisplayDocument {
  constructor(url = 'about:srcdoc') {
    this.URL = url;
    this.documentElement = new DisplayElement('html', this);
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
  }
  createElement(tagName) { return new DisplayElement(tagName, this); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.documentElement.descendants().find((node) => node.id === id) || null; }
}

function todoDocument(srcdoc, decisions, {url = 'about:srcdoc', token, duplicatePane = false,
  duplicateHeading = false, omitHeading = false, mismatchCard = false} = {}) {
  const doc = new DisplayDocument(url);
  const element = (tag, attributes = {}, text = '') => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.textContent = text;
    return node;
  };
  const renderToken = token ?? srcdoc.match(/<meta name="xuan-loader-render" content="([^"]+)">/)?.[1];
  doc.head.append(element('meta', {name: 'xuan-loader-render', content: renderToken || ''}));
  for (let index = 1; index <= 5; index += 1) {
    const radio = element('input', {id: `s${index}`, name: 'sec'});
    radio.checked = index === 1;
    doc.body.append(radio);
  }
  const label = element('label', {for: 's4'}, '待办');
  label.append(element('span', {class: 'dot'}, String(decisions.filter((item) => item.status === 'awaiting_user').length)));
  doc.body.append(label);
  const pane = element('div', {class: 'pane p4'});
  const card = element('div', {class: 'card'});
  if (!omitHeading) card.append(element('h2', {'data-decision-group-title': 'awaiting_user'}, '⑤ 待决定事项'));
  if (duplicateHeading) card.append(element('h2', {'data-decision-group-title': 'awaiting_user'}, '重复标题'));
  card.append(element('p', {}, '当前为只读清单；请在 Claude App 中引用事项编号回复。'));
  for (const item of decisions.filter((decision) => decision.status === 'awaiting_user')) {
    const details = element('details', {
      class: 'dcard', id: item.decisionId,
      'data-decision-id': mismatchCard ? 'D-20260830-WRONG' : item.decisionId,
      'data-decision-status': item.status,
    });
    details.append(element('summary', {}, `${item.decisionId} · 原始待办`));
    details.append(element('p', {}, '原始金额 $100.00；原始意见不变'));
    card.append(details);
  }
  card.append(element('h2', {'data-decision-group-title': 'resolved'}, '已决定 / 待落实'));
  for (const item of decisions.filter((decision) => decision.status !== 'awaiting_user')) {
    const details = element('details', {
      class: 'dcard', id: item.decisionId,
      'data-decision-id': item.decisionId, 'data-decision-status': item.status,
    });
    details.append(element('summary', {}, '已决定 / 待落实'));
    card.append(details);
  }
  const closed = element('details');
  closed.append(element('summary', {}, '已结案 / 只读观察'));
  const trigger = element('details');
  trigger.append(element('summary', {}, '⑥ 换仓触发检查'));
  trigger.append(element('p', {}, '触发无；GTC 12 张'));
  pane.append(card, closed, trigger);
  doc.body.append(pane);
  if (duplicatePane) doc.body.append(element('div', {class: 'pane p4'}));
  return {doc, pane, card, closed, trigger};
}

function loaderHarness({fetchImpl, stored = new Map(), now = '2026-08-28T06:00:00Z', displayDom = false,
  privateEtfImport = null, confirm = () => true, storageBlocked = false, handoffBlocked = false,
  headerGuide = true, headerGuideBody = true, mobileDisplayImport = null}) {
  const listeners = {adhoc: {}, stopAdhoc: {}, decision: {}, button: {}, appUpdate: {}, window: {}, document: {}};
  const progressTasks = new Map();
  const confirmations = [];
  const navigations = [];
  const intervals = [];
  let frameSrcdoc = '';
  const frame = {
    srcdocWrites: 0, contentDocument: null, writes: [], attributes: new Map([['sandbox', '']]),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      this.writes.push({attribute: name, value: String(value)});
    },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
  };
  Object.defineProperty(frame, 'srcdoc', {
    get: () => frameSrcdoc,
    set: (value) => { frameSrcdoc = value; frame.srcdocWrites += 1; frame.writes.push({attribute: 'srcdoc', value}); },
  });
  const adhoc = {
    disabled: false,
    addEventListener: (name, callback) => { listeners.adhoc[name] = callback; },
  };
  const adhocLabel = {textContent: '生成临时报告'};
  const adhocHint = {textContent: '确认后启动'};
  const stopAdhoc = {hidden: true,
    addEventListener: (name, callback) => { listeners.stopAdhoc[name] = callback; },
  };
  const button = {
    disabled: false,
    addEventListener: (name, callback) => { listeners.button[name] = callback; },
  };
  const appUpdate = {
    hidden: true,
    addEventListener: (name, callback) => { listeners.appUpdate[name] = callback; },
  };
  const outerDocument = displayDom ? new DisplayDocument('https://example.test/xuan-ib/') : null;
  const decision = displayDom ? outerDocument.createElement('button') : {
    hidden: true,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
  };
  decision.hidden = true;
  decision.addEventListener = (name, callback) => { listeners.decision[name] = callback; };
  const decisionAttributes = decision.attributes;
  const decisionCount = displayDom ? outerDocument.createElement('span') : {textContent: '0'};
  decisionCount.textContent = '0';
  if (displayDom) {
    decision.id = 'decision';
    decisionCount.id = 'decision-count';
    decision.append(decisionCount);
    outerDocument.body.append(decision);
  }
  const status = {textContent: '', classList: classList()};
  const warning = {hidden: true, textContent: '上游暂不一致，正在显示上一份已验证版本', classList: classList()};
  const elements = new Map([
    ['.header-guide > summary', headerGuide ? {} : null],
    ['.header-guide .guide-body', headerGuideBody ? {} : null],
    ['#adhoc', adhoc],
    ['#adhoc-label', adhocLabel],
    ['#adhoc-hint', adhocHint],
    ['#stop-adhoc', stopAdhoc],
    ['#decision', decision],
    ['#decision-count', decisionCount],
    ['#handover', frame],
    ['#refresh', button],
    ['#app-update', appUpdate],
    ['#status', status],
    ['#warning', warning],
  ]);
  const localStorage = {
    setItem: (key, value) => {
      if (storageBlocked) throw new Error('storage unavailable');
      stored.set(key, String(value));
    },
    getItem: (key) => stored.has(key) ? stored.get(key) : null,
    removeItem: (key) => stored.delete(key),
  };
  const warnings = [];
  const document = {
    hidden: false,
    querySelector: (selector) => elements.get(selector),
    addEventListener: (name, callback) => { listeners.document[name] = callback; },
  };
  const window = {
    confirm: (message) => { confirmations.push(message); return confirm(message); },
    addEventListener: (name, callback) => { listeners.window[name] = callback; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: (callback, delay) => {
      intervals.push({callback, delay});
      return intervals.length;
    },
  };
  const NativeDate = Date;
  let nowEpoch = new NativeDate(now).getTime();
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [nowEpoch])); }
    static now() { return nowEpoch; }
  }
  class TestDOMParser {
    parseFromString(html) {
      const visible = html.replace(/<!--[\s\S]*?-->/g, '');
      return {
        querySelectorAll: (selector) => {
          assert.equal(selector, 'template#xuan-ib-decision-state-v1');
          const templates = [];
          const pattern = /<template\b([^>]*)>([\s\S]*?)<\/template\s*>/gi;
          for (const match of visible.matchAll(pattern)) {
            if (!/\bid\s*=\s*(["'])xuan-ib-decision-state-v1\1/i.test(match[1])) continue;
            templates.push({content: {textContent: match[2]}, textContent: match[2]});
          }
          return templates;
        },
      };
    }
  }
  let href = 'https://example.test/xuan-ib/';
  const location = {get href() { return href; }, set href(value) {
    if (handoffBlocked) throw new Error('handoff blocked');
    navigations.push(value); href = value;
  }};
  const context = {
    AbortController,
    atob,
    Array,
    Date: FixedDate,
    DOMParser: TestDOMParser,
    Error,
    Intl,
    JSON,
    Map,
    Number,
    Promise,
    RegExp,
    String,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    Uint8Array,
    console: {warn: (...args) => warnings.push(args)},
    crypto: crypto.webcrypto,
    document,
    fetch: fetchImpl,
    localStorage,
    location,
    window,
    __importPrivateEtf: privateEtfImport,
    __importMobileDisplay: mobileDisplayImport,
    // Observe the real task's completion without awaiting it in the production
    // caller, changing its result, or replacing validation/rendering logic.
    __trackProgress: (request, task) => { progressTasks.set(request, task); },
  };
  // Execute the real loader and its actual event wiring. Substitute only the
  // dynamic network imports and observe fire-and-forget progress promises;
  // no production validation, rendering or concurrency logic is reimplemented.
  const importExpression = "import(etfUrl.href)";
  if (privateEtfImport) assert.equal(inlineScript.split(importExpression).length, 2);
  let testScript = privateEtfImport ? inlineScript.replace(importExpression, '__importPrivateEtf()') : inlineScript;
  if (mobileDisplayImport) {
    assert.equal(testScript.split('import(mobileUrl.href)').length, 2);
    testScript = testScript.replace('import(mobileUrl.href)', '__importMobileDisplay(mobileUrl.href)');
  }
  const progressDispatch = /void refreshProgress\((record|lastVerified), request\);/g;
  assert.equal([...testScript.matchAll(progressDispatch)].length, 2);
  testScript = testScript.replace(progressDispatch,
    (_, record) => `void __trackProgress(request, refreshProgress(${record}, request));`);
  vm.runInNewContext(testScript, context);
  return {
    progressTasks,
    adhoc,
    adhocLabel,
    adhocHint,
    stopAdhoc,
    confirmations,
    navigations,
    advanceTime: (milliseconds) => { nowEpoch += milliseconds; },
    button,
    appUpdate,
    decision,
    decisionAttributes,
    decisionCount,
    document,
    frame,
    loadFrame: (doc) => { frame.contentDocument = doc; frame.onload?.(); },
    outerDocument,
    intervals,
    listeners,
    location,
    status,
    stored,
    warning,
    warnings,
  };
}

function privateDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const settlePrivateLoader = () => new Promise(resolve => setImmediate(resolve));

async function mobileLoaderFixture(importer) {
  const html = reportHtml('2026-08-28', '早间版', decisionTemplate()), meta = metaFor(html);
  const app = loaderHarness({displayDom: true, mobileDisplayImport: importer,
    fetchImpl: async url => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const fixture = todoDocument(app.frame.srcdoc, []);
  app.loadFrame(fixture.doc); await settlePrivateLoader();
  return {app, doc: fixture.doc, html};
}

test('explicit refresh retries a failed layout import without replacing the verified document', async () => {
  const urls = [], applied = [];
  const view = {improveMobileDisplay: doc => {
    assert.equal(Boolean(doc.getElementById('xuan-mobile-layout-status')), false, 'loader-only notice is removed before report enhancement');
    applied.push(doc);
  }, organizeRoutineRecords() {}};
  const {app, doc, html} = await mobileLoaderFixture(url => {
    urls.push(url); return urls.length === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(view);
  });
  assert.match(doc.getElementById('xuan-mobile-layout-status').textContent, /系统将自动重试/);
  const writes = app.frame.srcdocWrites;
  const radio = doc.getElementById('s4'); radio.checked = true;
  await app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(urls.length, 2); assert.notEqual(urls[0], urls[1], 'failed browser module cache is not reused');
  assert.deepEqual(applied, [doc]); assert.equal(app.frame.srcdocWrites, writes);
  assert.equal(radio.checked, true); assert.equal(Boolean(doc.getElementById('xuan-mobile-layout-status')), false);
  assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html, html);
  await app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(urls.length, 2); assert.deepEqual(applied, [doc], 'successful mutation is never repeated');
});

test('background refresh automatically retries a failed layout and pending imports are single flight', async () => {
  const gate = privateDeferred(); let imports = 0, applies = 0;
  const {app} = await mobileLoaderFixture(() => { imports++; return gate.promise; });
  await app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(imports, 1);
  gate.reject(new Error('blocked')); await settlePrivateLoader();
  app.advanceTime(6 * 60_000);
  await app.listeners.document.visibilitychange(); await settlePrivateLoader();
  assert.equal(imports, 2, 'the next background poll performs one bounded automatic retry');
  assert.equal(applies, 0);
});

test('a partial display failure is not applied a second time to mutated DOM', async () => {
  let applies = 0;
  const {app, doc} = await mobileLoaderFixture(() => Promise.resolve({improveMobileDisplay(d) {
    applies++; d.partialMutation = true; throw new Error('partial display failure');
  }}));
  assert.equal(doc.partialMutation, true);
  assert.match(doc.getElementById('xuan-mobile-layout-status').textContent, /重新打开页面/);
  await app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(applies, 1); assert.ok(app.frame.srcdoc.includes('xuan-loader-render'));
});

test('late layout import never mutates a document that left the verified frame', async () => {
  const gate = privateDeferred(), applied = [];
  const {app, doc} = await mobileLoaderFixture(() => gate.promise);
  app.frame.contentDocument = new DisplayDocument('https://example.test/unverified');
  gate.resolve({improveMobileDisplay: d => applied.push(d)}); await settlePrivateLoader();
  assert.deepEqual(applied, []); assert.notEqual(app.frame.contentDocument, doc);
});

function privateViewStub(firstMountWait = null) {
  const runs = [], clears = [];
  return {runs, clears,
    async mountEtfTrend({doc, isCurrent}) {
      const run = {doc, isCurrent, controller: new AbortController()}; runs.push(run);
      if (isCurrent()) doc.privateText = `SYNTHETIC VERIFIED ${runs.length}`;
      if (firstMountWait && runs.length === 1) {
        await firstMountWait.promise;
        if (isCurrent() && !run.controller.signal.aborted) doc.privateText = 'SYNTHETIC LATE RESULT';
      }
    },
    clearEtfTrend(doc) {
      clears.push(doc);
      for (const run of runs) if (run.doc === doc) run.controller.abort();
      if (doc) doc.privateText = null;
    },
  };
}
async function privateLoaderFixture({view = privateViewStub(), importer = null} = {}) {
  const html = reportHtml('2026-08-28', '早间版', decisionTemplate()), meta = metaFor(html);
  let gate = null, fetches = 0, imports = 0;
  const app = loaderHarness({displayDom: true,
    privateEtfImport: () => { imports++; return importer ? importer() : Promise.resolve(view); },
    fetchImpl: async (url) => {
      fetches++; if (gate) await gate;
      return String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)});
    },
  });
  await app.listeners.button.click();
  const fixture = todoDocument(app.frame.srcdoc, []), etf = fixture.doc.createElement('section');
  etf.className = 'pane p5'; fixture.doc.body.append(etf);
  app.loadFrame(fixture.doc); await settlePrivateLoader();
  return {app, doc: fixture.doc, view, etf, fetches: () => fetches, imports: () => imports,
    blockReport: promise => { gate = promise; }};
}

test('loader pagehide synchronously clears private plaintext and invalidates pending work without visibilitychange', async () => {
  const wait = privateDeferred(), view = privateViewStub(wait), f = await privateLoaderFixture({view});
  assert.ok(f.doc.privateText); assert.equal(f.app.document.hidden, false);
  assert.equal(view.runs.length, 1); const run = view.runs[0];
  f.app.listeners.window.pagehide({persisted: true});
  // Assertions happen in the same call stack, before any Promise can settle.
  assert.equal(f.doc.privateText, null); assert.equal(view.clears.length, 1);
  assert.equal(run.isCurrent(), false); assert.equal(run.controller.signal.aborted, true);
  wait.resolve(); await settlePrivateLoader();
  assert.equal(f.doc.privateText, null);
  await f.app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(view.runs.length, 1, 'a pending report refresh cannot remount after pagehide');
});

test('loader BFCache pageshow starts a fresh private read even while report fetch is blocked', async () => {
  const f = await privateLoaderFixture(), before = f.view.runs.length, wait = privateDeferred();
  f.app.listeners.window.pagehide({persisted: true});
  assert.equal(f.doc.privateText, null);
  f.blockReport(wait.promise);
  const showing = f.app.listeners.window.pageshow({persisted: true});
  await settlePrivateLoader();
  assert.ok(f.view.runs.length > before); assert.ok(f.doc.privateText);
  assert.equal(f.view.runs.at(-1).isCurrent(), true);
  wait.resolve(); await showing; await settlePrivateLoader();
  assert.equal(f.imports(), 1, 'successful module reference can be reused, not its private payload');
});

test('loader pagehide during module import suppresses its late mount until pageshow', async () => {
  const wait = privateDeferred(), view = privateViewStub();
  const f = await privateLoaderFixture({view, importer: () => wait.promise});
  assert.equal(view.runs.length, 0);
  f.app.listeners.window.pagehide({persisted: true});
  wait.resolve(view); await settlePrivateLoader();
  assert.equal(view.runs.length, 0); assert.equal(f.doc.privateText, undefined);
  await f.app.listeners.window.pageshow({persisted: true}); await settlePrivateLoader();
  assert.ok(view.runs.length > 0); assert.ok(f.doc.privateText);
});

test('loader visibility lifecycle still synchronously clears and freshly remounts', async () => {
  const f = await privateLoaderFixture(); const previous = f.view.runs.at(-1);
  f.app.document.hidden = true;
  f.app.listeners.document.visibilitychange();
  assert.equal(f.doc.privateText, null); assert.equal(previous.isCurrent(), false);
  assert.equal(previous.controller.signal.aborted, true);
  f.app.document.hidden = false;
  f.app.listeners.document.visibilitychange(); await settlePrivateLoader();
  assert.ok(f.doc.privateText); assert.ok(f.view.runs.length > 1);
});

test('loader visibility return cannot reactivate a page hidden by pagehide before pageshow', async () => {
  const f = await privateLoaderFixture(), count = f.view.runs.length;
  f.app.listeners.window.pagehide({persisted: false});
  f.app.document.hidden = false;
  f.app.listeners.document.visibilitychange(); await settlePrivateLoader();
  assert.equal(f.view.runs.length, count); assert.equal(f.doc.privateText, null);
  await f.app.listeners.window.pageshow({persisted: false}); await settlePrivateLoader();
  assert.ok(f.view.runs.length > count); assert.ok(f.doc.privateText);
});

test('loader transient module import failure is retryable by ordinary refresh', async () => {
  const view = privateViewStub(); let attempt = 0;
  const f = await privateLoaderFixture({view, importer: () => ++attempt === 1
    ? Promise.reject(new Error('SYNTHETIC NETWORK FAILURE')) : Promise.resolve(view)});
  assert.equal(view.runs.length, 0);
  const note = f.doc.getElementById('xuan-etf-load-status'); assert.ok(note);
  assert.match(note.textContent, /自动重试/); assert.doesNotMatch(note.textContent, /SYNTHETIC NETWORK FAILURE/);
  await f.app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(f.imports(), 2); assert.ok(view.runs.length > 0); assert.ok(f.doc.privateText);
  assert.equal(f.doc.getElementById('xuan-etf-load-status'), null);
});

test('loader late rejected import does not append notices after leaving, and return retries', async () => {
  const wait = privateDeferred(), view = privateViewStub(); let attempt = 0;
  const f = await privateLoaderFixture({view, importer: () => ++attempt === 1 ? wait.promise : Promise.resolve(view)});
  f.app.listeners.window.pagehide({persisted: true});
  wait.reject(new Error('SYNTHETIC LATE FAILURE')); await settlePrivateLoader();
  assert.equal(f.doc.getElementById('xuan-etf-load-status'), null); assert.equal(view.runs.length, 0);
  await f.app.listeners.window.pageshow({persisted: true}); await settlePrivateLoader();
  assert.equal(f.imports(), 2); assert.ok(f.doc.privateText);
});

test('the fixed XUAN-IB URL is a stable cache-busting loader', () => {
  assert.match(loader, /new URL\("latest\.meta\.json", location\.href\)/);
  assert.match(loader, /new URL\("latest\.html", location\.href\)/);
  assert.match(loader, /Date\.now\(\)/);
  assert.match(loader, /Promise\.all\(\[/);
  assert.match(loader, /fetch\(metaUrl, options\)/);
  assert.match(loader, /fetch\(htmlUrl, options\)/);
  assert.match(loader, /cache: "no-store"/);
  assert.match(loader, /credentials: "omit"/);
  assert.match(loader, /signal: controller\.signal/);
  assert.match(loader, /controller\.abort\(\), 10_000/);
  assert.match(loader, /crypto\.subtle\.digest\("SHA-1", payload\)/);
  assert.match(loader, /blob \$\{body\.byteLength\}\\0/);
  assert.match(loader, /blob\.toLowerCase\(\) !== meta\.htmlBlob\.toLowerCase\(\)/);
  assert.match(loader, /schemaVersion !== 1/);
  assert.match(loader, /info\.dataDate !== meta\.dataDate/);
  assert.match(loader, /lastSuccess = verifiedAt;/);
  assert.match(loader, /if \(request !== requestSequence\) return/);
  assert.match(loader, /lastAttempt = Date\.now\(\)/);
  assert.match(loader, /Date\.now\(\) - lastAttempt > \(inDeliveryWindow \? 30_000 : 5 \* 60_000\)/);
  assert.match(loader, /visibilitychange/);
  assert.match(loader, /button\.addEventListener\("click", \(\) => loadLatest\(\{retryLayout: true\}\)\)/);
  assert.match(loader, /record\.info\.dataDate/);
  assert.match(loader, /record\.info\.edition/);
  assert.ok(loader.includes(`loaderBuild = "${appBuild.build}"`));
  assert.equal(appBuild.schemaVersion, 1);
  assert.match(loader, /new URL\("app-build\.json", location\.href\)/);
  assert.match(loader, /新版可用 · 点此更新页面/);
  assert.match(loader, /<button id="refresh"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(loader, /正在检查已发布报告/);
  assert.doesNotMatch(loader, /history-link|href="history\/2026-09-05-am\.html"|周六上午版\s*·\s*新排版/);
  assert.match(loader, /requestSequence/);
  assert.match(loader, /xuan-ib:last-verified:v1/);
  assert.match(loader, /storage\.setItem\(storageKey/);
  assert.match(loader, /restoreVerified\(request\)/);
  assert.match(loader, /requireMonotonic\(/);
  assert.match(loader, /record\.meta\.dataDate < previous\.meta\.dataDate/);
  assert.match(loader, /record\.meta\.sourceCommitEpoch < previous\.meta\.sourceCommitEpoch/);
  assert.match(loader, /record\.meta\.htmlBlob\.toLowerCase\(\) !== previous\.meta\.htmlBlob\.toLowerCase\(\)/);
  assert.match(loader, /上游暂不一致，正在显示上一份已验证版本/);
  assert.match(loader, /Content-Security-Policy/);
  assert.match(loader, /default-src &apos;none&apos;/);
  assert.match(loader, /style-src &apos;unsafe-inline&apos;/);
  assert.match(loader, /<iframe[^>]+sandbox=""/);
  assert.doesNotMatch(loader, /loadDirect/);
  assert.doesNotMatch(loader, /内容未校验/);
  assert.doesNotMatch(loader, /serviceWorker/);
  assert.doesNotMatch(loader, /<!--\s*xuan-ib-handover:v1\s*-->/);
});

test('a newer app build offers one deliberate update without touching the verified report', async () => {
  const html = reportHtml('2026-09-16', '睡前版', 'verified-report');
  const meta = metaFor(html);
  const newerBuild = appBuild.build.replace(/\.(\d+)$/, (_, revision) => `.${Number(revision) + 1}`);
  const app = loaderHarness({fetchImpl: async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/app-build.json')) return response({json:{schemaVersion:1,build:newerBuild}});
    return path.endsWith('/latest.meta.json')
      ? response({json:meta,bytes:[]}) : response({bytes:Buffer.from(html)});
  }});
  await app.listeners.window.pageshow({persisted:false});
  await settlePrivateLoader();
  assert.match(app.frame.srcdoc,/verified-report/);
  assert.equal(app.appUpdate.hidden,false);
  assert.equal(app.navigations.length,0,'detecting a release cannot interrupt reading');
  app.location.href = 'https://example.test/xuan-ib/?release=old';
  app.listeners.appUpdate.click();
  assert.equal(app.navigations.at(-1),`https://example.test/xuan-ib/?app=${newerBuild}`);
});

test('same or unavailable app build remains quiet and never blocks report verification', async () => {
  const html = reportHtml('2026-09-16', '睡前版', 'verified-report');
  const meta = metaFor(html);
  for (const manifest of [{schemaVersion:1,build:appBuild.build},
    {schemaVersion:1,build:'2026-09-16.1'}, {schemaVersion:1,build:'broken'}]) {
    const app = loaderHarness({fetchImpl: async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/app-build.json')) return response({json:manifest});
      return path.endsWith('/latest.meta.json')
        ? response({json:meta,bytes:[]}) : response({bytes:Buffer.from(html)});
    }});
    await app.listeners.window.pageshow({persisted:false});
    await settlePrivateLoader();
    assert.equal(app.appUpdate.hidden,true);
    assert.match(app.frame.srcdoc,/verified-report/);
  }
});

test('delivery-window polling checks published bytes sooner without starting a generator', async () => {
  const html = reportHtml('2026-09-15', '睡前版', 'verified-report');
  const meta = metaFor(html);
  let reportFetches = 0;
  const app = loaderHarness({now:'2026-09-16T13:30:00Z',fetchImpl:async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/latest.meta.json')) { reportFetches++; return response({json:meta,bytes:[]}); }
    return response({bytes:Buffer.from(html)});
  }});
  await app.listeners.button.click();
  const tick = app.intervals.find(({delay})=>delay===30_000);
  assert.ok(tick);
  app.advanceTime(31_000); tick.callback(); await settlePrivateLoader();
  assert.equal(reportFetches,2);
  assert.match(app.warning.textContent,/等待今晚睡前版/);
  assert.doesNotMatch(app.warning.textContent,/正在生成/);
});

test('the decision control uses one fixed Shortcut URL and never embeds report or user data', () => {
  const control = loader.match(/<button id="decision"[\s\S]*?<\/button>/)?.[0];
  assert.ok(control, 'the trusted parent must own the decision launcher');
  assert.match(
    loader,
    /const decisionShortcutUrl = "shortcuts:\/\/run-shortcut\?name=XUAN-IB%20%E5%9B%9E%E5%BA%94%E5%BE%85%E5%8A%9E"/
  );
  assert.match(control, /type="button"/);
  assert.match(control, /hidden/);
  assert.match(control, /回应待办/);
  assert.doesNotMatch(control, /\bhref=|\bonclick=|\btarget=/);
  assert.doesNotMatch(control, /decisionId|sourceSha|htmlBlob|publicSummary|token|secret|api[_-]?key/i);
  assert.doesNotMatch(loader.match(/<header\b[\s\S]*?<\/header>/)?.[0] || '', /id="decision"|回应待办/);
  assert.match(loader, /<div id="decision-parking" hidden>/);
  const sandbox = loader.match(/<iframe\b[^>]*\bsandbox="([^"]*)"/)?.[1];
  assert.equal(sandbox, '', 'the initial frame starts fully sandboxed');
  const allowedSandboxValues = [...loader.matchAll(/frame\.setAttribute\("sandbox", "([^"]*)"\)/g)].map((match) => match[1]);
  assert.deepEqual(new Set(allowedSandboxValues), new Set(['allow-same-origin', '']),
    'only a verified report can get same-origin; scripts, forms, popups and navigation remain forbidden');
  for (const directive of ['default-src', 'script-src', 'connect-src', 'frame-src', 'object-src', 'form-action']) {
    assert.ok(loader.includes(`${directive} &apos;none&apos;`), `${directive} remains blocked`);
  }
  assert.match(loader, /xuan-ib:decision-wait:v1/);
  assert.match(loader, /waitTimeoutMs = 20 \* 60_000/);
  assert.match(loader, /decisionButton\.addEventListener\("click", beginDecisionWait\)/);
  assert.match(loader, /event\.preventDefault\(\)/);
  assert.match(loader, /location\.href = decisionShortcutUrl/);
  assert.doesNotMatch(loader, /decisionButton\.onclick\s*=/);
  assert.doesNotMatch(loader, /clipboard/i);
});

test('only an enabled inert decision template reveals the compact awaiting-user count', async () => {
  const variants = [
    {
      body: '正文里写 awaiting_user 不得被当成机器状态',
      hidden: true,
      count: '0',
    },
    {
      body: '<!-- <template id="xuan-ib-decision-state-v1">{"schemaVersion":1,"interaction":"enabled","decisions":[{"decisionId":"D-20260830-COMMENT","status":"awaiting_user"}],"receipts":[]}</template> -->',
      hidden: true,
      count: '0',
    },
    {
      body: decisionTemplate({interaction: 'disabled', decisions: [awaitingDecision()]}),
      hidden: true,
      count: '1',
    },
    {
      body: decisionTemplate({decisions: [{decisionId: 'D-20260830-ACCEPTED', status: 'accepted'}]}),
      hidden: false,
      count: '0',
    },
    {
      body: decisionTemplate({
        decisions: [awaitingDecision(), awaitingDecision('D-20260830-SECOND-ITEM')],
      }),
      hidden: false,
      count: '2',
    },
  ];

  for (const [index, variant] of variants.entries()) {
    const html = reportHtml('2026-08-30', '临时版', variant.body);
    const app = loaderHarness({
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: metaFor(html), bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(app.decision.hidden, variant.hidden, `variant ${index}`);
    assert.equal(app.decisionCount.textContent, variant.count, `variant ${index}`);
    assert.equal(app.decision.disabled, variant.hidden || variant.count === '0', `variant ${index}`);
    assert.equal(app.decisionAttributes.get('aria-disabled'), String(variant.hidden || variant.count === '0'));
    assert.equal(app.decisionCount.hidden, variant.count === '0');
  }
});

test('verified todo display expands the first trigger and keeps a collapsed pending fold beside the parent button', async () => {
  const decisions = [awaitingDecision(), awaitingDecision('D-20260830-SECOND-ITEM'),
    {decisionId: 'D-20260830-ALREADY-ACCEPTED', status: 'accepted'}];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + '原始财务正文 $100.00');
  const meta = metaFor(html);
  let fetches = 0;
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => {
    fetches += 1;
    return String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)});
  }});
  const record = await app.listeners.button.click();
  const fixture = todoDocument(app.frame.srcdoc, decisions);
  const originalCards = decisions.map((item) => fixture.doc.getElementById(item.decisionId));
  const originalTexts = originalCards.map((card) => card.textContent);
  const originalButton = app.decision;
  const originalListener = app.listeners.decision.click;

  app.loadFrame(fixture.doc);

  const row = fixture.doc.querySelector('.xuan-decision-row');
  const fold = fixture.doc.querySelector('.xuan-decision-fold');
  const body = fixture.doc.querySelector('.xuan-decision-body');
  assert.equal(fixture.pane.children[0], fixture.trigger);
  assert.equal(fixture.trigger.hasAttribute('open'), true, 'swap trigger starts expanded');
  assert.equal(fixture.closed.hasAttribute('open'), false, 'closed observations remain collapsed');
  assert.equal(row.parentElement, fixture.card);
  assert.equal(fold.parentElement, row);
  assert.equal(fold.hasAttribute('open'), false, 'pending content starts collapsed');
  assert.equal(fold.querySelector('summary').textContent, '待决定事项⚠ 2 项');
  assert.equal(fold.querySelector('summary').getAttribute('aria-label'), '待决定事项，2 项待你确认');
  assert.equal(app.decision, originalButton, 'move the parent-owned element, never clone a report action');
  assert.equal(app.decision.parentElement, row, 'button is a sibling of the fold, not inside its summary');
  assert.equal(app.decision.ownerDocument, fixture.doc);
  assert.equal(app.decisionCount.ownerDocument, fixture.doc, 'adoption includes the count');
  assert.equal(app.listeners.decision.click, originalListener, 'parent callback survives document adoption');
  assert.deepEqual(body.children, originalCards.slice(0, 2));
  assert.equal(originalCards[2].parentElement, fixture.doc.querySelector('.xuan-progress-body'), 'already-decided items stay outside pending in their own closed progress group');
  assert.deepEqual(originalCards.map((card) => card.textContent), originalTexts);
  assert.equal(fixture.card.children.some((node) => node.tagName === 'P' && node.textContent.startsWith('当前为只读清单')), false);
  const displayStyle = fixture.doc.head.querySelector('style').textContent;
  assert.match(displayStyle, /\.xuan-decision-row\{position:relative/);
  assert.match(displayStyle, /\.xuan-decision-fold\{display:block/);
  assert.match(displayStyle, /\.xuan-decision-fold>summary\{width:calc\(100% - 108px\)/);
  assert.match(displayStyle, /\.xuan-decision-body\{width:100%;min-width:0\}/);
  assert.match(displayStyle, /#decision\{position:absolute;top:0;right:0;width:100px/);
  assert.doesNotMatch(displayStyle, /display:contents|display:grid|grid-column/);
  assert.match(fixture.doc.head.querySelector('style').textContent, /\.xuan-decision-fold:not\(\[open\]\)>\.xuan-decision-body\{display:none\}/);

  const saved = JSON.parse(app.stored.get('xuan-ib:last-verified:v1'));
  assert.equal(saved.html, html, 'display mutation never changes the cached canonical HTML');
  assert.equal(record.html, html);
  assert.equal(record.blob, gitBlobSha(Buffer.from(html)));
  assert.deepEqual(saved.meta, meta);
  assert.doesNotMatch(saved.html, /xuan-decision-row|xuan-loader-render/);

  let prevented = false;
  const beforeClickFetches = fetches;
  app.listeners.decision.click({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.match(app.location.href, /^shortcuts:\/\/run-shortcut\?name=XUAN-IB%20/);
  assert.equal(fetches, beforeClickFetches, 'the real click must launch synchronously without awaiting a refresh');
  const wait = JSON.parse(app.stored.get('xuan-ib:decision-wait:v1'));
  assert.deepEqual(wait.awaitingDecisionIds, decisions.slice(0, 2).map((item) => item.decisionId));
  assert.equal(wait.baselines[0].htmlBlob, meta.htmlBlob);
});

test('legacy reports only expand the matching swap trigger and leave other details unchanged', async () => {
  for (const hasTrigger of [true, false]) {
    const html = reportHtml('2026-08-30', '临时版', 'legacy report without a decision template');
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, []);
    if (!hasTrigger) fixture.trigger.querySelector('summary').textContent = '其他检查';
    const untouched = fixture.doc.createElement('details');
    untouched.setAttribute('open', '');
    fixture.pane.append(untouched);
    app.loadFrame(fixture.doc);

    assert.equal(fixture.trigger.hasAttribute('open'), hasTrigger);
    assert.equal(fixture.closed.hasAttribute('open'), false);
    assert.equal(untouched.hasAttribute('open'), true);
    assert.equal(fixture.doc.querySelector('.xuan-decision-fold'), null);
    assert.equal(app.decision.hidden, true);
  }
});

test('zero pending keeps a disabled inline response control and preserves all accepted items', async () => {
  const decisions = [1, 2, 3].map((number) => ({decisionId: `D-20260830-ACCEPTED-${number}`, status: 'accepted'}));
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const fixture = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(fixture.doc);

  assert.equal(app.decision.hidden, false);
  assert.equal(app.decision.disabled, true);
  assert.equal(app.decisionAttributes.get('aria-disabled'), 'true');
  assert.equal(app.decisionCount.hidden, true);
  assert.equal(fixture.doc.querySelector('.xuan-decision-fold').hasAttribute('open'), false);
  assert.equal(fixture.doc.querySelector('.xuan-decision-fold').querySelector('summary').textContent, '待决定事项0 项');
  assert.match(fixture.doc.querySelector('.xuan-decision-empty').textContent, /暂无待决定事项/);
  assert.equal(fixture.doc.querySelector('label[for="s4"] .dot'), null, 'zero is not a pending attention badge');
  for (const item of decisions) assert.equal(fixture.doc.getElementById(item.decisionId).parentElement, fixture.doc.querySelector('.xuan-progress-body'));
  app.listeners.decision.click({preventDefault() {}});
  assert.equal(app.location.href, 'https://example.test/xuan-ib/');
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
});

test('todo controls fail closed on missing or ambiguous containers, headings and pending cards', async () => {
  const decisions = [awaitingDecision()];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  for (const variant of [{duplicatePane: true}, {duplicateHeading: true}, {omitHeading: true}, {mismatchCard: true}]) {
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, decisions, variant);
    app.loadFrame(fixture.doc);
    assert.equal(app.decision.ownerDocument, app.outerDocument, JSON.stringify(variant));
    assert.equal(fixture.doc.querySelector('.xuan-decision-row'), null, JSON.stringify(variant));
    app.listeners.decision.click({preventDefault() {}});
    assert.equal(app.location.href, 'https://example.test/xuan-ib/', JSON.stringify(variant));
    assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false, JSON.stringify(variant));
  }
});

test('ordinary AM and PM reports retain the response control with one explicit legacy pending H2', async () => {
  for (const edition of ['早间版', '睡前版']) {
    const decisions = [awaitingDecision(), {decisionId: 'D-20260830-RESOLVED', status: 'accepted'}];
    const html = reportHtml('2026-08-30', edition, decisionTemplate({decisions}));
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, decisions);
    for (const heading of fixture.doc.querySelectorAll('[data-decision-group-title]')) heading.removeAttribute('data-decision-group-title');
    const pendingCard = fixture.doc.getElementById(decisions[0].decisionId);
    app.loadFrame(fixture.doc);
    assert.equal(app.decision.ownerDocument, fixture.doc, edition);
    assert.equal(fixture.doc.querySelector('.xuan-decision-fold').hasAttribute('open'), false, edition);
    assert.equal(fixture.doc.querySelector('.xuan-decision-body').children[0], pendingCard, edition);
    assert.equal(fixture.doc.getElementById(decisions[1].decisionId).parentElement, fixture.card, edition);
    app.listeners.decision.click({preventDefault() {}});
    assert.match(app.location.href, /^shortcuts:\/\/run-shortcut\?name=XUAN-IB%20/, edition);
  }
});

test('legacy compatibility rejects conflicting groups, lookalike titles and misplaced or duplicate pending cards', async () => {
  const variants = ['duplicate-legacy', 'lookalike-title', 'incomplete-typed-groups', 'marker-without-typed-heading',
    'typed-and-legacy-conflict', 'card-before-heading', 'card-after-resolved-heading', 'card-inside-trigger',
    'duplicate-card-id', 'duplicate-decision-id', 'non-details-card'];
  const decisions = [awaitingDecision()];
  for (const variant of variants) {
    const groupMarker = variant === 'marker-without-typed-heading' ? '<!-- xuan-ib-decision-group:v1:awaiting_user:start -->' : '';
    const html = reportHtml('2026-08-30', '睡前版', decisionTemplate({decisions}) + groupMarker);
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, decisions);
    const heading = fixture.doc.querySelector('[data-decision-group-title="awaiting_user"]');
    const pendingCard = fixture.doc.getElementById(decisions[0].decisionId);
    if (variant !== 'typed-and-legacy-conflict') {
      for (const node of fixture.doc.querySelectorAll('[data-decision-group-title]')) node.removeAttribute('data-decision-group-title');
    }
    if (variant === 'duplicate-legacy' || variant === 'typed-and-legacy-conflict') {
      const duplicate = fixture.doc.createElement('h2');
      duplicate.textContent = '⑤ 待决定事项';
      fixture.card.append(duplicate);
    } else if (variant === 'lookalike-title') heading.textContent = '说明：⑤ 待决定事项';
    else if (variant === 'incomplete-typed-groups') fixture.card.querySelectorAll('h2')[1].setAttribute('data-decision-group-title', 'resolved');
    else if (variant === 'card-before-heading') fixture.card.prepend(pendingCard);
    else if (variant === 'card-after-resolved-heading') fixture.card.append(pendingCard);
    else if (variant === 'card-inside-trigger') fixture.trigger.append(pendingCard);
    else if (variant === 'duplicate-card-id' || variant === 'duplicate-decision-id') {
      const duplicate = fixture.doc.createElement('details');
      duplicate.setAttribute(variant === 'duplicate-card-id' ? 'id' : 'data-decision-id', decisions[0].decisionId);
      fixture.doc.body.append(duplicate);
    } else if (variant === 'non-details-card') pendingCard.tagName = 'DIV';

    app.loadFrame(fixture.doc);
    assert.equal(app.decision.ownerDocument, app.outerDocument, variant);
    assert.equal(fixture.doc.querySelector('.xuan-decision-row'), null, variant);
    app.listeners.decision.click({preventDefault() {}});
    assert.equal(app.location.href, 'https://example.test/xuan-ib/', variant);
    assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false, variant);
  }
});

test('the frame only gains same-origin immediately before verified HTML and keeps errors fully sandboxed', async () => {
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions: [awaitingDecision()]}));
  let valid = false;
  const app = loaderHarness({fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: metaFor(html, valid ? {} : {htmlBlob: 'f'.repeat(40)}), bytes: []})
    : response({bytes: Buffer.from(html)})});
  assert.equal(app.frame.getAttribute('sandbox'), '');
  await app.listeners.button.click();
  assert.equal(app.frame.getAttribute('sandbox'), '');
  assert.equal(app.frame.writes.some((write) => write.attribute === 'sandbox' && write.value !== ''), false);
  assert.match(app.frame.srcdoc, /暂时无法读取最新交接页/);
  valid = true;
  await app.listeners.button.click();
  assert.equal(app.frame.getAttribute('sandbox'), 'allow-same-origin');
  const verifiedWrite = app.frame.writes.findLastIndex((write) => write.attribute === 'srcdoc');
  assert.deepEqual(app.frame.writes[verifiedWrite - 1], {attribute: 'sandbox', value: 'allow-same-origin'});
  assert.match(app.frame.writes[verifiedWrite].value, /Content-Security-Policy/);
  assert.match(app.frame.writes[verifiedWrite].value, /script-src &apos;none&apos;/);
  valid = false;
  await app.listeners.button.click();
  assert.equal(app.frame.getAttribute('sandbox'), 'allow-same-origin', 'a last-verified fallback is still trusted');
  assert.match(app.frame.srcdoc, /xuan-ib-decision-state-v1/);
  assert.equal(app.frame.writes.filter((write) => write.attribute === 'sandbox')
    .every((write) => ['', 'allow-same-origin'].includes(write.value)), true);
});

test('a changed or missing render token invalidates the launcher even within the same installed document', async () => {
  const decisions = [awaitingDecision()];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  for (const missing of [false, true]) {
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, decisions);
    app.loadFrame(fixture.doc);
    const token = fixture.doc.querySelector('meta[name="xuan-loader-render"]');
    if (missing) token.remove();
    else token.content = 'another-render';
    app.listeners.decision.click({preventDefault() {}});
    assert.equal(app.location.href, 'https://example.test/xuan-ib/');
    assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
  }
});

test('iframe load requires the current render token and the actual about:srcdoc document', async () => {
  const decisions = [awaitingDecision()];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  for (const variant of [{token: 'xuan-render-forged'}, {url: 'https://example.test/other'}, {url: 'about:blank'}]) {
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const fixture = todoDocument(app.frame.srcdoc, decisions, variant);
    app.loadFrame(fixture.doc);
    assert.equal(app.decision.ownerDocument, app.outerDocument, JSON.stringify(variant));
    assert.equal(fixture.doc.querySelector('.xuan-decision-row'), null);
    app.listeners.decision.click({preventDefault() {}});
    assert.equal(app.location.href, 'https://example.test/xuan-ib/');
    assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
  }
});

test('late prior-frame loads cannot bind a new verified report to an old displayed document', async () => {
  const decisions = [awaitingDecision()];
  let html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'version A');
  let meta = metaFor(html);
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const first = todoDocument(app.frame.srcdoc, decisions);
  const firstLoad = app.frame.onload;

  html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'version B');
  meta = metaFor(html, {sourceSha: '2'.repeat(40), sourceCommitEpoch: meta.sourceCommitEpoch + 1});
  await app.listeners.button.click();
  const second = todoDocument(app.frame.srcdoc, decisions);
  app.frame.contentDocument = first.doc;
  firstLoad();
  assert.equal(app.decision.ownerDocument, app.outerDocument, 'old callback is rejected by render sequence');
  app.frame.onload();
  assert.equal(app.decision.ownerDocument, app.outerDocument, 'current callback also rejects old document token');
  app.loadFrame(second.doc);
  assert.equal(app.decision.ownerDocument, second.doc);

  app.frame.contentDocument = first.doc;
  app.listeners.decision.click({preventDefault() {}});
  assert.equal(app.location.href, 'https://example.test/xuan-ib/', 'a detached old document cannot initiate a decision');
  app.frame.contentDocument = second.doc;
  second.doc.URL = 'https://example.test/unverified-navigation';
  app.listeners.decision.click({preventDefault() {}});
  assert.equal(app.location.href, 'https://example.test/xuan-ib/', 'navigation away from srcdoc invalidates the launcher');
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
});

test('polling the same verified blob preserves the active todo tab, open fold and DOM identity', async () => {
  const decisions = [awaitingDecision()];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const fixture = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(fixture.doc);
  const fold = fixture.doc.querySelector('.xuan-decision-fold');
  fold.setAttribute('open', '');
  fixture.trigger.removeAttribute('open');
  fixture.doc.getElementById('s1').checked = false;
  fixture.doc.getElementById('s4').checked = true;
  const initialWrites = app.frame.srcdocWrites;

  await app.listeners.button.click();

  assert.equal(app.frame.srcdocWrites, initialWrites);
  assert.equal(app.frame.contentDocument, fixture.doc);
  assert.equal(fixture.doc.querySelector('.xuan-decision-fold'), fold);
  assert.equal(fold.hasAttribute('open'), true);
  assert.equal(fixture.trigger.hasAttribute('open'), false, 'same-report refresh preserves a manually collapsed trigger');
  assert.equal(fixture.doc.getElementById('s4').checked, true);
  assert.equal(app.decision.ownerDocument, fixture.doc);
  assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html, html);
});

test('refreshing the same verified blob restores an iframe that navigated away or lost its render identity', async () => {
  const decisions = [awaitingDecision()];
  const html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}));
  for (const failure of ['navigated-away', 'same-url-new-document', 'changed-token', 'failed-load']) {
    const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    const original = todoDocument(app.frame.srcdoc, decisions);
    if (failure === 'failed-load') {
      app.loadFrame(todoDocument(app.frame.srcdoc, decisions, {token: 'failed-load-token'}).doc);
    } else {
      app.loadFrame(original.doc);
      if (failure === 'navigated-away') {
        app.frame.contentDocument = new DisplayDocument('https://example.test/elsewhere');
      } else if (failure === 'same-url-new-document') {
        app.frame.contentDocument = todoDocument(app.frame.srcdoc, decisions).doc;
      } else {
        original.doc.querySelector('meta[name="xuan-loader-render"]').content = 'changed-token';
      }
    }
    const beforeRefreshWrites = app.frame.srcdocWrites;
    const oldToken = app.frame.srcdoc.match(/<meta name="xuan-loader-render" content="([^"]+)">/)?.[1];

    await app.listeners.button.click();

    assert.equal(app.frame.srcdocWrites, beforeRefreshWrites + 1, failure);
    const restored = todoDocument(app.frame.srcdoc, decisions);
    assert.notEqual(restored.doc.querySelector('meta[name="xuan-loader-render"]').content, oldToken, failure);
    app.loadFrame(restored.doc);
    assert.equal(app.decision.ownerDocument, restored.doc, failure);
    assert.equal(restored.pane.children[0], restored.trigger, failure);
    assert.equal(restored.trigger.hasAttribute('open'), true, failure);
    assert.equal(restored.doc.querySelector('.xuan-decision-fold').hasAttribute('open'), false, failure);
    app.listeners.decision.click({preventDefault() {}});
    assert.match(app.location.href, /^shortcuts:\/\/run-shortcut\?name=XUAN-IB%20/, failure);
    assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html, html, failure);
  }
});

test('a new verified blob keeps the selected todo tab but starts its pending fold collapsed', async () => {
  const decisions = [awaitingDecision()];
  let html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'first');
  let meta = metaFor(html);
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const first = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(first.doc);
  first.doc.getElementById('s1').checked = false;
  first.doc.getElementById('s4').checked = true;
  first.doc.querySelector('.xuan-decision-fold').setAttribute('open', '');
  first.trigger.removeAttribute('open');
  html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'second');
  meta = metaFor(html, {sourceSha: '2'.repeat(40), sourceCommitEpoch: meta.sourceCommitEpoch + 1});
  await app.listeners.button.click();
  const second = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(second.doc);
  assert.equal(second.doc.getElementById('s4').checked, true);
  assert.equal(second.doc.querySelector('.xuan-decision-fold').hasAttribute('open'), false);
  assert.equal(second.trigger.hasAttribute('open'), true, 'a new report uses the expanded trigger default');
  assert.equal(app.decision.ownerDocument, second.doc);
  assert.equal(first.doc.querySelector('#decision'), null, 'the existing control is moved out of the retired document');
});

test('a new verified blob keeps the selected independent ETF tab', async () => {
  const decisions = [awaitingDecision()];
  let html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'first');
  let meta = metaFor(html);
  const app = loaderHarness({displayDom: true, fetchImpl: async (url) => String(url).includes('latest.meta.json')
    ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const first = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(first.doc);
  first.doc.getElementById('s1').checked = false;
  first.doc.getElementById('s5').checked = true;

  html = reportHtml('2026-08-30', '临时版', decisionTemplate({decisions}) + 'second');
  meta = metaFor(html, {sourceSha: '2'.repeat(40), sourceCommitEpoch: meta.sourceCommitEpoch + 1});
  await app.listeners.button.click();
  const second = todoDocument(app.frame.srcdoc, decisions);
  app.loadFrame(second.doc);

  assert.equal(second.doc.getElementById('s5').checked, true);
  assert.equal(app.decision.ownerDocument, second.doc);
});

test('malformed or duplicate decision templates fail closed instead of exposing an action', async () => {
  const invalidStates = [
    '<template id="xuan-ib-decision-state-v1">{"schemaVersion":1,"interaction":"enabled","decisions":[],"receipts":[],"extra":true}</template>',
    decisionTemplate({decisions: [awaitingDecision()]}) + decisionTemplate({decisions: []}),
    '<template id="xuan-ib-decision-state-v1">{"schemaVersion":1,"interaction":"enabled","decisions":[{"decisionId":"bad","status":"awaiting_user"}],"receipts":[]}</template>',
  ];
  for (const body of invalidStates) {
    const html = reportHtml('2026-08-30', '临时版', body);
    const app = loaderHarness({
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: metaFor(html), bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(app.decision.hidden, true);
    assert.doesNotMatch(app.frame.srcdoc, /xuan-ib-decision-state-v1/);
    assert.match(app.status.textContent, /暂时无法读取已验证报告/);
  }
});

test('the loader accepts the same millisecond-precision HKT receipts as the guard', async () => {
  const html = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({
      decisions: [awaitingDecision()],
      receipts: [{
        receiptId: 'R-20260830-154500-A1B2C3D4',
        decisionId: 'D-20260830-TEST-ITEM',
        action: 'deferred',
        responseToSourceSha: '1'.repeat(40),
        responseToHtmlBlob: '2'.repeat(40),
        recordedAtHkt: '2026-08-30T15:45:00.125+08:00',
        publicSummary: '稍后决定；只记录，不执行',
      }],
    })
  );
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });

  await app.listeners.button.click();

  assert.equal(app.decision.hidden, false);
  assert.match(app.frame.srcdoc, /2026-08-30T15:45:00\.125\+08:00/);
});

test('decision launch synchronously snapshots the verified report before opening Claude', async () => {
  const html = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]})
  );
  const meta = metaFor(html, {sourceCommitEpoch: 1_788_000_000});
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });
  await app.listeners.button.click();
  assert.equal(app.decision.hidden, false);

  let prevented = false;
  app.listeners.decision.click({preventDefault: () => { prevented = true; }});

  assert.equal(prevented, true);
  assert.equal(
    app.location.href,
    'shortcuts://run-shortcut?name=XUAN-IB%20%E5%9B%9E%E5%BA%94%E5%BE%85%E5%8A%9E'
  );
  const wait = JSON.parse(app.stored.get('xuan-ib:decision-wait:v1'));
  assert.equal(wait.cacheVersion, 2);
  assert.deepEqual(wait.awaitingDecisionIds, ['D-20260830-TEST-ITEM']);
  assert.deepEqual(wait.initialReceiptIds, []);
  assert.equal(wait.baselines[0].sourceSha, meta.sourceSha);
  assert.equal(wait.baselines[0].htmlBlob, meta.htmlBlob);
  assert.deepEqual(wait.baselines[0].awaitingDecisionIds, ['D-20260830-TEST-ITEM']);
  assert.match(app.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  assert.equal(app.stored.has('xuan-ib:adhoc-wait:v1'), false);
});

test('decision launch fails closed without a verified report and suppresses duplicate starts', async () => {
  const html = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]})
  );
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });

  app.listeners.decision.click({preventDefault: () => {}});
  assert.equal(app.location.href, 'https://example.test/xuan-ib/');
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
  assert.match(app.status.textContent, /^正在自动确认当前待办/);

  await app.listeners.button.click();
  app.listeners.decision.click({preventDefault: () => {}});
  const firstWait = app.stored.get('xuan-ib:decision-wait:v1');
  assert.match(app.location.href, /^shortcuts:/);
  app.location.href = 'https://example.test/xuan-ib/';
  app.listeners.decision.click({preventDefault: () => {}});
  assert.equal(app.location.href, 'https://example.test/xuan-ib/');
  assert.equal(app.stored.get('xuan-ib:decision-wait:v1'), firstWait);
});

test('A to B to C completes only when C carries a new target receipt bound to verified B', async () => {
  const baselineHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]})
  );
  const baselineMeta = metaFor(baselineHtml, {sourceCommitEpoch: 1_788_000_000});
  let current = {html: baselineHtml, meta: baselineMeta};
  const app = loaderHarness({
    now: '2026-08-30T07:45:00.900Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: current.meta, bytes: []})
      : response({json: null, bytes: Buffer.from(current.html)}),
  });
  await app.listeners.button.click();
  app.listeners.decision.click({preventDefault: () => {}});
  app.location.href = 'https://example.test/xuan-ib/';

  const noReceiptHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]}) + 'ordinary-newer-publication'
  );
  current = {
    html: noReceiptHtml,
    meta: metaFor(noReceiptHtml, {sourceCommitEpoch: 1_788_000_060}),
  };
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  await poll.callback();
  assert.match(app.frame.srcdoc, /ordinary-newer-publication/);
  assert.match(app.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  assert.ok(app.stored.has('xuan-ib:decision-wait:v1'));
  const waitAfterB = JSON.parse(app.stored.get('xuan-ib:decision-wait:v1'));
  assert.equal(waitAfterB.baselines.length, 2);
  assert.equal(waitAfterB.baselines[1].sourceSha, current.meta.sourceSha);
  assert.equal(waitAfterB.baselines[1].htmlBlob, current.meta.htmlBlob);
  assert.deepEqual(waitAfterB.baselines[1].awaitingDecisionIds, ['D-20260830-TEST-ITEM']);

  const bMeta = current.meta;

  const receipt = {
    receiptId: 'R-20260830-154500-A1B2C3D4',
    decisionId: 'D-20260830-TEST-ITEM',
    action: 'accepted',
    responseToSourceSha: bMeta.sourceSha,
    responseToHtmlBlob: bMeta.htmlBlob,
    recordedAtHkt: '2026-08-30T15:45:00+08:00',
    publicSummary: '采纳 Claude 意见；只记录，不执行',
  };
  const completedHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({
      decisions: [{decisionId: receipt.decisionId, status: 'accepted'}],
      receipts: [receipt],
    }) + 'receipt-completed-publication'
  );
  current = {
    html: completedHtml,
    meta: metaFor(completedHtml, {sourceCommitEpoch: 1_788_000_120}),
  };
  await poll.callback();

  assert.match(app.frame.srcdoc, /receipt-completed-publication/);
  assert.match(app.status.textContent, /回应已记录 · 已检查/);
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
});

test('a decision first introduced in B can complete when C binds its receipt to B', async () => {
  const originalDecision = awaitingDecision();
  const newDecision = awaitingDecision('D-20260830-INTRODUCED-IN-B');
  const aHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [originalDecision]})
  );
  const aMeta = metaFor(aHtml, {sourceCommitEpoch: 1_788_000_000});
  let current = {html: aHtml, meta: aMeta};
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: current.meta, bytes: []})
      : response({json: null, bytes: Buffer.from(current.html)}),
  });
  await app.listeners.button.click();
  app.listeners.decision.click({preventDefault: () => {}});
  app.location.href = 'https://example.test/xuan-ib/';

  const bHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [originalDecision, newDecision]}) + 'B-adds-decision'
  );
  current = {
    html: bHtml,
    meta: metaFor(bHtml, {sourceCommitEpoch: 1_788_000_060}),
  };
  const bMeta = current.meta;
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  await poll.callback();
  const waitAfterB = JSON.parse(app.stored.get('xuan-ib:decision-wait:v1'));
  assert.deepEqual(
    waitAfterB.baselines[1].awaitingDecisionIds,
    ['D-20260830-TEST-ITEM', 'D-20260830-INTRODUCED-IN-B']
  );

  const receipt = {
    receiptId: 'R-20260830-154503-NEWINB01',
    decisionId: newDecision.decisionId,
    action: 'accepted',
    responseToSourceSha: bMeta.sourceSha,
    responseToHtmlBlob: bMeta.htmlBlob,
    recordedAtHkt: '2026-08-30T15:45:03+08:00',
    publicSummary: '采纳新增待办意见；只记录，不执行',
  };
  const cHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({
      decisions: [originalDecision, {decisionId: newDecision.decisionId, status: 'accepted'}],
      receipts: [receipt],
    }) + 'C-binds-B-new-decision'
  );
  current = {
    html: cHtml,
    meta: metaFor(cHtml, {sourceCommitEpoch: 1_788_000_120}),
  };
  await poll.callback();
  assert.match(app.frame.srcdoc, /C-binds-B-new-decision/);
  assert.match(app.status.textContent, /回应已记录 · 已检查/);
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
});

test('a mismatched, old, or pre-click receipt never completes the decision wait', async () => {
  const baselineHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]})
  );
  const baselineMeta = metaFor(baselineHtml, {sourceCommitEpoch: 1_788_000_000});
  let current = {html: baselineHtml, meta: baselineMeta};
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: current.meta, bytes: []})
      : response({json: null, bytes: Buffer.from(current.html)}),
  });
  await app.listeners.button.click();
  app.listeners.decision.click({preventDefault: () => {}});
  app.location.href = 'https://example.test/xuan-ib/';

  const unrelatedReceipt = {
    receiptId: 'R-20260830-154501-Z9Y8X7W6',
    decisionId: 'D-20260830-TEST-ITEM',
    action: 'deferred',
    responseToSourceSha: '2'.repeat(40),
    responseToHtmlBlob: '3'.repeat(40),
    recordedAtHkt: '2026-08-30T15:45:01+08:00',
    publicSummary: '稍后决定；只记录，不执行',
  };
  const newerHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()], receipts: [unrelatedReceipt]})
  );
  current = {
    html: newerHtml,
    meta: metaFor(newerHtml, {sourceCommitEpoch: 1_788_000_060}),
  };
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  await poll.callback();
  assert.match(app.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  assert.ok(app.stored.has('xuan-ib:decision-wait:v1'));

  app.advanceTime(20 * 60_000 + 1);
  await poll.callback();
  assert.equal(app.status.textContent, `尚未收到回应回执，系统将自动重试 · L ${appBuild.build}`);
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
});

test('receipts for non-initial decisions or genuinely pre-click times stay pending', async () => {
  const baselineHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({
      decisions: [
        awaitingDecision(),
        {decisionId: 'D-20260830-CLOSED-ITEM', status: 'accepted'},
      ],
    })
  );
  const baselineMeta = metaFor(baselineHtml, {sourceCommitEpoch: 1_788_000_000});
  let current = {html: baselineHtml, meta: baselineMeta};
  const app = loaderHarness({
    now: '2026-08-30T07:45:00.900Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: current.meta, bytes: []})
      : response({json: null, bytes: Buffer.from(current.html)}),
  });
  await app.listeners.button.click();
  app.listeners.decision.click({preventDefault: () => {}});
  app.location.href = 'https://example.test/xuan-ib/';

  const receipts = [
    {
      receiptId: 'R-20260830-154501-NONTARGT',
      decisionId: 'D-20260830-CLOSED-ITEM',
      action: 'accepted',
      responseToSourceSha: baselineMeta.sourceSha,
      responseToHtmlBlob: baselineMeta.htmlBlob,
      recordedAtHkt: '2026-08-30T15:45:01+08:00',
      publicSummary: '已结案事项回执；只记录，不执行',
    },
    {
      receiptId: 'R-20260830-154502-TOOEARLY',
      decisionId: 'D-20260830-TEST-ITEM',
      action: 'deferred',
      responseToSourceSha: baselineMeta.sourceSha,
      responseToHtmlBlob: baselineMeta.htmlBlob,
      recordedAtHkt: '2026-08-30T15:44:58+08:00',
      publicSummary: '稍后决定；只记录，不执行',
    },
  ];
  const newerHtml = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({
      decisions: [
        awaitingDecision(),
        {decisionId: 'D-20260830-CLOSED-ITEM', status: 'accepted'},
      ],
      receipts,
    })
  );
  current = {
    html: newerHtml,
    meta: metaFor(newerHtml, {sourceCommitEpoch: 1_788_000_060}),
  };
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  await poll.callback();
  assert.match(app.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  const wait = JSON.parse(app.stored.get('xuan-ib:decision-wait:v1'));
  assert.deepEqual(wait.awaitingDecisionIds, ['D-20260830-TEST-ITEM']);
  assert.equal(wait.baselines.length, 2);
});

test('decision pending survives reload and refresh triggers without treating its baseline as complete', async () => {
  const html = reportHtml(
    '2026-08-30',
    '临时版',
    decisionTemplate({decisions: [awaitingDecision()]})
  );
  const meta = metaFor(html, {sourceCommitEpoch: 1_788_000_000});
  const stored = new Map();
  let requestCount = 0;
  const fetchImpl = async (url) => {
    requestCount += 1;
    return String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)});
  };
  const first = loaderHarness({fetchImpl, stored});
  await first.listeners.button.click();
  await first.listeners.decision.click({preventDefault: () => {}});
  assert.ok(stored.has('xuan-ib:decision-wait:v1'));

  const reloaded = loaderHarness({fetchImpl, stored});
  assert.match(reloaded.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  await reloaded.listeners.window.pageshow({persisted: true});
  assert.match(reloaded.frame.srcdoc, /xuan-ib-decision-state-v1/);
  assert.match(reloaded.status.textContent, /^请在手机菜单中选择；提交后等待回应回执/);
  assert.ok(stored.has('xuan-ib:decision-wait:v1'));

  const beforeFocus = requestCount;
  await reloaded.listeners.window.focus();
  assert.equal(requestCount, beforeFocus + 2);
  assert.ok(stored.has('xuan-ib:decision-wait:v1'));
});

test('a schema-v1 metadata and HTML pair is rendered only after its exact Git blob matches', async () => {
  const html = reportHtml('2026-08-28', '睡前版', 'fresh-pair');
  const meta = metaFor(html);
  const requests = [];
  const app = loaderHarness({
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)));
      return String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes: Buffer.from(html)});
    },
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /fresh-pair/);
  assert.match(app.frame.srcdoc, /Content-Security-Policy/);
  assert.match(app.status.textContent, /^报告 08-28 睡前版\n已检查 \d{2}:\d{2}$/);
  assert.doesNotMatch(app.status.textContent, /\bL\b|2026-09-16\.2/);
  assert.equal(app.status.classList.contains('error'), false);
  assert.equal(app.warning.hidden, true);
  assert.equal(app.button.disabled, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('v'), requests[1].searchParams.get('v'));
  const saved = JSON.parse(app.stored.get('xuan-ib:last-verified:v1'));
  assert.equal(saved.cacheVersion, 1);
  assert.equal(saved.meta.htmlBlob, meta.htmlBlob);
  assert.equal(saved.html, html);
});

test('fixed page suppresses only the embedded guide before first paint and preserves canonical bytes', async () => {
  const body = '<div class="page"><div class="wrap"><details class="mobile-guide"><summary>使用指南 · 30 秒上手</summary><p>Guide</p></details><details><summary>报告说明</summary></details></div></div>';
  const html = reportHtml('2026-08-28', '早间版', body), meta = metaFor(html);
  const app = loaderHarness({fetchImpl: async url => String(url).includes('latest.meta.json')
    ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
  await app.listeners.button.click();
  const style = '<style id="xuan-embedded-guide-style">.page > .wrap > details.mobile-guide{display:none!important}</style>';
  assert.ok(app.frame.srcdoc.includes(style));
  assert.ok(app.frame.srcdoc.indexOf(style) < app.frame.srcdoc.indexOf('<body>'), 'style is present before iframe load / async imports');
  assert.ok(app.frame.srcdoc.includes(body), 'display rule never deletes source content or other explanations');
  const cached = JSON.parse(app.stored.get('xuan-ib:last-verified:v1'));
  assert.equal(cached.html, html);
  assert.equal(cached.meta.htmlBlob, gitBlobSha(Buffer.from(html)));
  assert.doesNotMatch(cached.html, /xuan-embedded-guide-style/);
  await app.listeners.button.click();
  assert.equal(app.frame.srcdoc.split(style).length, 2, 'refresh is idempotent');
  const restored = loaderHarness({stored: app.stored, fetchImpl: async () => { throw new Error('offline'); }});
  await restored.listeners.button.click();
  assert.ok(restored.frame.srcdoc.includes(style), 'offline verified cache uses the same display rule');
  assert.match(loader, /<details class="header-guide"><summary>使用指南<\/summary><div class="guide-body">/);
});

test('an absent or incomplete header guide never suppresses the report only guide', async () => {
  const html = reportHtml('2026-08-28', '早间版', '<details class="mobile-guide"><summary>使用指南</summary></details>'), meta = metaFor(html);
  for (const options of [{headerGuide: false}, {headerGuideBody: false}]) {
    const app = loaderHarness({...options, fetchImpl: async url => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)})});
    await app.listeners.button.click();
    assert.doesNotMatch(app.frame.srcdoc, /xuan-embedded-guide-style/);
    assert.match(app.frame.srcdoc, /<details class="mobile-guide">/);
  }
});

test('a bounded external script injected in transit is removed only when the trusted Git blob is restored', async () => {
  const html = reportHtml('2026-08-28', '睡前版', 'trusted-after-transport');
  const injected = html.replace(
    '</head>',
    "<script type='text/javascript' src='https://huanwujoy-crypto.github.io/nordvpn-injected.js'></script></head>"
  );
  const meta = metaFor(html);
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(injected)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /trusted-after-transport/);
  assert.doesNotMatch(app.frame.srcdoc, /nordvpn-injected/);
  assert.equal(app.warning.hidden, true);
  assert.equal(app.status.classList.contains('error'), false);
  assert.equal(app.warnings.length, 1);
  assert.match(String(app.warnings[0][0]), /transport-injected external script/);
  const saved = JSON.parse(app.stored.get('xuan-ib:last-verified:v1'));
  assert.equal(saved.html, html, 'only the exact trusted HTML may be cached');
});

test('transport recovery still fails closed when any trusted report byte was also changed', async () => {
  const html = reportHtml('2026-08-28', '睡前版', 'trusted-body');
  const injectedAndChanged = html
    .replace('trusted-body', 'changed-body')
    .replace('</head>', "<script src='https://example.invalid/injected.js'></script></head>");
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []})
      : response({json: null, bytes: Buffer.from(injectedAndChanged)}),
  });

  await app.listeners.button.click();

  assert.doesNotMatch(app.frame.srcdoc, /changed-body/);
  assert.match(app.frame.srcdoc, /暂时无法读取最新交接页/);
  assert.match(app.status.textContent, /暂时无法读取已验证报告/);
  assert.equal(app.stored.has('xuan-ib:last-verified:v1'), false);
});

test('transport recovery rejects ambiguous scripts, invalid UTF-8, and removal-limit overflow', async () => {
  const html = reportHtml('2026-08-28', '睡前版', 'must-remain-trusted');
  const meta = metaFor(html);
  const variants = [
    html.replace('</head>', "<script data-src='https://example.invalid/not-src.js'></script></head>"),
    html.replace('</head>', '<script>globalThis.modified = true</script></head>'),
    html.replace('</head>', "<script src='https://example.invalid/unclosed.js'></head>"),
    html.replace(
      '</head>',
      Array.from({length: 5}, (_, index) =>
        `<script src='https://example.invalid/${index}.js'></script>`
      ).join('') + '</head>'
    ),
    html.replace(
      '</head>',
      `<script data-padding='${'x'.repeat(65 * 1024)}' src='https://example.invalid/large.js'></script></head>`
    ),
    Buffer.concat([Buffer.from(html), Buffer.from([0xff])]),
  ];

  for (const variant of variants) {
    const bytes = Buffer.isBuffer(variant) ? variant : Buffer.from(variant);
    const app = loaderHarness({
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes}),
    });
    await app.listeners.button.click();
    assert.doesNotMatch(app.frame.srcdoc, /must-remain-trusted/);
    assert.match(app.frame.srcdoc, /暂时无法读取最新交接页/);
    assert.equal(app.stored.has('xuan-ib:last-verified:v1'), false);
  }
});

test('Saturday retains Friday PM but clearly warns when only Thursday PM is published', async () => {
  const html = reportHtml('2026-08-27', '睡前版', 'trusted-thursday');
  const meta = metaFor(html);
  const app = loaderHarness({
    now: '2026-08-29T00:21:00Z', // Saturday 08:21 HKT
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /trusted-thursday/);
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /今晚睡前版发布延迟/);
  assert.match(app.warning.textContent, /当前继续显示 2026-08-27 睡前版/);
  assert.equal(app.status.classList.contains('error'), true);
});

test('refresh preserves a delayed warning until the current PM pair has passed verification', async () => {
  const oldHtml = reportHtml('2026-09-15', '睡前版', 'old-verified');
  const freshHtml = reportHtml('2026-09-16', '睡前版', 'fresh-verified');
  let currentHtml = oldHtml, gate = null;
  const app = loaderHarness({now: '2026-09-16T13:51:00Z', fetchImpl: async url => {
    if (gate) await gate.promise;
    return String(url).includes('latest.meta.json')
      ? response({json: metaFor(currentHtml), bytes: []})
      : response({json: null, bytes: Buffer.from(currentHtml)});
  }});
  await app.listeners.button.click();
  const warning = app.warning.textContent;
  gate = privateDeferred();
  const refresh = app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(app.warning.hidden, false); assert.equal(app.warning.textContent, warning);
  assert.equal(app.status.classList.contains('error'), true);
  assert.match(app.status.textContent, /正在检查已发布报告/);
  currentHtml = freshHtml; gate.resolve(); await refresh;
  assert.equal(app.warning.hidden, true); assert.equal(app.status.classList.contains('error'), false);
  assert.match(app.frame.srcdoc, /fresh-verified/);
});

test('the PM window changes from a blue updating notice to a delayed warning at T+20', async () => {
  const html = reportHtml('2026-09-15', '睡前版', 'crossing-deadline');
  let gate = null;
  const app = loaderHarness({now: '2026-09-16T13:49:00Z', fetchImpl: async url => {
    if (gate) await gate.promise;
    return String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []})
      : response({json: null, bytes: Buffer.from(html)});
  }});
  await app.listeners.button.click();
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /等待今晚睡前版/);
  assert.equal(app.warning.classList.contains('info'), true);
  assert.equal(app.status.classList.contains('error'), false);
  app.advanceTime(61_000); gate = privateDeferred();
  const refresh = app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /今晚睡前版发布延迟/);
  assert.equal(app.warning.classList.contains('info'), false);
  assert.equal(app.status.classList.contains('error'), true);
  gate.resolve(); await refresh;
  assert.equal(app.warning.hidden, false, 'the same old pair cannot clear the warning');
});

test('refresh does not clear a transport warning or accept mismatched fresh-looking bytes', async () => {
  const html = reportHtml('2026-09-15', '睡前版', 'trusted');
  let failed = false, gate = null;
  const app = loaderHarness({now: '2026-09-16T01:40:00Z', fetchImpl: async url => {
    if (gate) await gate.promise;
    return String(url).includes('latest.meta.json')
      ? response({json: metaFor(html), bytes: []})
      : response({json: null, bytes: Buffer.from(failed ? html.replace('trusted', 'untrusted') : html)});
  }});
  await app.listeners.button.click(); failed = true; await app.listeners.button.click();
  assert.equal(app.warning.hidden, false); const warning = app.warning.textContent;
  gate = privateDeferred(); const refresh = app.listeners.button.click(); await settlePrivateLoader();
  assert.equal(app.warning.hidden, false); assert.equal(app.warning.textContent, warning);
  gate.resolve(); await refresh;
  assert.equal(app.warning.hidden, false); assert.doesNotMatch(app.frame.srcdoc, /untrusted/);
});

test('Friday PM remains current through the weekend and Monday before the PM window', async () => {
  const html = reportHtml('2026-09-18', '睡前版', 'trusted-friday-pm');
  const meta = metaFor(html);
  for (const now of ['2026-09-19T01:00:00Z', '2026-09-20T12:00:00Z', '2026-09-21T13:29:59Z']) {
    const app = loaderHarness({
      now,
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(app.warning.hidden, true, `${now} must accept the last Friday PM report`);
    assert.equal(app.status.classList.contains('error'), false);
  }
});

test('bedtime-only notices follow start, T+20, full-PM and priority boundaries', async () => {
  const cases = [
    ['2026-09-16T01:35:00Z', '2026-09-15', '睡前版', null],
    ['2026-09-16T13:29:59Z', '2026-09-15', '睡前版', null],
    ['2026-09-16T13:30:00Z', '2026-09-15', '睡前版', 'info'],
    ['2026-09-16T13:49:59Z', '2026-09-15', '睡前版', 'info'],
    ['2026-09-16T13:50:00Z', '2026-09-15', '睡前版', 'error'],
    ['2026-09-16T13:40:00Z', '2026-09-16', '临时版 · 睡前速览', 'info'],
    ['2026-09-16T13:50:00Z', '2026-09-16', '临时版 · 睡前速览', 'error'],
    ['2026-09-16T13:35:00Z', '2026-09-16', '睡前版', null],
    ['2026-11-02T05:00:00Z', '2026-10-30', '开市前版', 'info'],
    ['2026-11-02T05:20:00Z', '2026-10-30', '开市前版', 'error'],
  ];
  for (const [now, date, edition, level] of cases) {
    const html = reportHtml(date, edition, `${date}-${edition}`);
    const meta = metaFor(html);
    const app = loaderHarness({
      now,
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(app.warning.hidden, level === null, `${now} / ${date} / ${edition}`);
    assert.equal(app.warning.classList.contains('info'), level === 'info', `${now} / ${date} / ${edition}`);
    assert.equal(app.status.classList.contains('error'), level === 'error', `${now} / ${date} / ${edition}`);
  }
});

test('a newer ad-hoc report is an informational preview before T+20', async () => {
  const html = reportHtml('2026-09-16', '临时版 · 睡前速览', 'trusted-adhoc');
  const meta = metaFor(html, {sourceCommitEpoch: Date.parse('2026-09-16T13:40:00Z') / 1000});
  const app = loaderHarness({
    now: '2026-09-16T13:40:00Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });
  await app.listeners.button.click();
  assert.match(app.frame.srcdoc, /trusted-adhoc/);
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /等待今晚睡前版/);
  assert.equal(app.warning.classList.contains('info'), true);
  assert.equal(app.status.classList.contains('error'), false);
});

test('only a verified priority publication claims holdings and orders have updated', async () => {
  const html = reportHtml('2026-09-16', '临时版 · 睡前速览',
    '<section data-xuan-delivery="sleep-priority-v1">priority-published</section>');
  const meta = metaFor(html, {sourceCommitEpoch: Date.parse('2026-09-16T13:40:00Z') / 1000});
  for (const [now, expected] of [
    ['2026-09-16T13:40:00Z',/睡前速览已更新（持仓与挂单）；完整版待发布/],
    ['2026-09-16T13:50:00Z',/睡前速览已更新（持仓与挂单）；完整版发布延迟/],
  ]) {
    const app = loaderHarness({now,fetchImpl:async url => String(url).includes('latest.meta.json')
      ? response({json:meta,bytes:[]}) : response({bytes:Buffer.from(html)})});
    await app.listeners.button.click();
    assert.match(app.frame.srcdoc,/priority-published/);
    assert.match(app.warning.textContent,expected);
  }
});

test('an ad-hoc report cannot impersonate the full PM after T+20', async () => {
  const html = reportHtml('2026-09-01', '临时版', 'pre-slot-adhoc');
  const meta = metaFor(html, {sourceCommitEpoch: Date.parse('2026-09-01T12:30:00Z') / 1000});
  const app = loaderHarness({
    now: '2026-09-01T13:25:00Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });
  await app.listeners.button.click();
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /今晚睡前版发布延迟/);
  assert.equal(app.status.classList.contains('error'), true);
});

test('mixed metadata and HTML fail closed to the locally stored verified report', async () => {
  const cachedHtml = reportHtml('2026-08-27', '睡前版', 'known-good-cache');
  const cachedMeta = metaFor(cachedHtml);
  const freshHtml = reportHtml('2026-08-28', '临时版', 'unpaired-upstream');
  const stored = new Map([[
    'xuan-ib:last-verified:v1',
    JSON.stringify({cacheVersion: 1, html: cachedHtml, meta: cachedMeta, verifiedAt: 1}),
  ]]);
  const app = loaderHarness({
    stored,
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: {...metaFor(freshHtml), htmlBlob: 'f'.repeat(40)}, bytes: []})
      : response({json: null, bytes: Buffer.from(freshHtml)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /known-good-cache/);
  assert.doesNotMatch(app.frame.srcdoc, /unpaired-upstream/);
  assert.equal(app.warning.hidden, false);
  assert.match(app.warning.textContent, /上游暂不一致，正在显示上一份已验证版本/);
  assert.equal(app.status.textContent, '报告 08-27 睡前版\n显示上一份已验证报告');
  assert.equal(app.status.classList.contains('error'), true);
  assert.equal(app.button.disabled, false);
});

test('a valid but older report cannot replace the locally verified newer date', async () => {
  const cachedHtml = reportHtml('2026-08-28', '早间版', 'newer-local-report');
  const cachedMeta = metaFor(cachedHtml, {sourceCommitEpoch: 1_788_000_000});
  const incomingHtml = reportHtml('2026-08-27', '睡前版', 'older-upstream-report');
  const incomingMeta = metaFor(incomingHtml, {sourceCommitEpoch: 1_788_100_000});
  const stored = new Map([[
    'xuan-ib:last-verified:v1',
    JSON.stringify({cacheVersion: 1, html: cachedHtml, meta: cachedMeta, verifiedAt: 1}),
  ]]);
  const original = stored.get('xuan-ib:last-verified:v1');
  const app = loaderHarness({
    stored,
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: incomingMeta, bytes: []})
      : response({json: null, bytes: Buffer.from(incomingHtml)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /newer-local-report/);
  assert.doesNotMatch(app.frame.srcdoc, /older-upstream-report/);
  assert.equal(app.warning.hidden, false);
  assert.equal(app.status.classList.contains('error'), true);
  assert.equal(stored.get('xuan-ib:last-verified:v1'), original);
});

test('a lower source epoch on the same data date cannot roll back the verified report', async () => {
  const cachedHtml = reportHtml('2026-08-28', '睡前版', 'higher-epoch-local-report');
  const cachedMeta = metaFor(cachedHtml, {sourceCommitEpoch: 1_788_000_100});
  const incomingHtml = reportHtml('2026-08-28', '睡前版', 'lower-epoch-upstream-report');
  const incomingMeta = metaFor(incomingHtml, {sourceCommitEpoch: 1_788_000_000});
  const stored = new Map([[
    'xuan-ib:last-verified:v1',
    JSON.stringify({cacheVersion: 1, html: cachedHtml, meta: cachedMeta, verifiedAt: 1}),
  ]]);
  const original = stored.get('xuan-ib:last-verified:v1');
  const app = loaderHarness({
    stored,
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: incomingMeta, bytes: []})
      : response({json: null, bytes: Buffer.from(incomingHtml)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /higher-epoch-local-report/);
  assert.doesNotMatch(app.frame.srcdoc, /lower-epoch-upstream-report/);
  assert.equal(app.warning.hidden, false);
  assert.equal(app.status.classList.contains('error'), true);
  assert.equal(stored.get('xuan-ib:last-verified:v1'), original);
});

test('the same data date and source epoch fail closed when the HTML blob changes', async () => {
  const epoch = 1_788_000_100;
  const cachedHtml = reportHtml('2026-08-28', '睡前版', 'original-epoch-report');
  const cachedMeta = metaFor(cachedHtml, {sourceCommitEpoch: epoch});
  const incomingHtml = reportHtml('2026-08-28', '睡前版', 'conflicting-epoch-report');
  const incomingMeta = metaFor(incomingHtml, {sourceCommitEpoch: epoch});
  const stored = new Map([[
    'xuan-ib:last-verified:v1',
    JSON.stringify({cacheVersion: 1, html: cachedHtml, meta: cachedMeta, verifiedAt: 1}),
  ]]);
  const original = stored.get('xuan-ib:last-verified:v1');
  const app = loaderHarness({
    stored,
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: incomingMeta, bytes: []})
      : response({json: null, bytes: Buffer.from(incomingHtml)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /original-epoch-report/);
  assert.doesNotMatch(app.frame.srcdoc, /conflicting-epoch-report/);
  assert.equal(app.warning.hidden, false);
  assert.equal(app.status.classList.contains('error'), true);
  assert.equal(stored.get('xuan-ib:last-verified:v1'), original);
});

test('network failure retains the verified cache and never opens an unverified direct page', async () => {
  const cachedHtml = reportHtml('2026-08-27', '早间版', 'offline-cache');
  const stored = new Map([[
    'xuan-ib:last-verified:v1',
    JSON.stringify({cacheVersion: 1, html: cachedHtml, meta: metaFor(cachedHtml), verifiedAt: 1}),
  ]]);
  const app = loaderHarness({stored, fetchImpl: async () => { throw new TypeError('offline'); }});

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /offline-cache/);
  assert.equal(app.warning.hidden, false);
  assert.equal(app.status.textContent, '报告 08-27 早间版\n显示上一份已验证报告');
  assert.equal(app.status.classList.contains('error'), true);
});

test('unsupported metadata with no cache shows no report instead of rendering unchecked HTML', async () => {
  const html = reportHtml('2026-08-28', '睡前版', 'must-not-render');
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: metaFor(html, {schemaVersion: 2}), bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });

  await app.listeners.button.click();

  assert.doesNotMatch(app.frame.srcdoc, /must-not-render/);
  assert.match(app.frame.srcdoc, /暂时无法读取最新交接页/);
  assert.match(app.status.textContent, /暂时无法读取已验证报告/);
  assert.equal(app.warning.hidden, true);
});

test('the phone page is branded XUAN-投资管理 everywhere the reader sees it', () => {
  assert.match(loader, /<title>XUAN-投资管理<\/title>/);
  assert.match(
    loader,
    /<meta name="apple-mobile-web-app-title" content="XUAN-投资管理">/
  );
  assert.match(loader, /<strong>XUAN-投资管理<\/strong>/);
  assert.match(loader, /<iframe id="handover" title="XUAN-投资管理 最新简报"/);
  // The retired name may survive only inside the migration allowlist, never in
  // anything the reader is shown.
  const branding = loader.replace(/const approvedTitles = \[[\s\S]*?\];/, '');
  assert.doesNotMatch(branding, /XUAN-IB 睡前交接/);
  assert.doesNotMatch(branding, /content="XUAN-IB 交接"/);
  assert.doesNotMatch(branding, /title="XUAN-IB 最新睡前交接"/);
});

test('the integrity check accepts legacy reports and the canonical action page', () => {
  // The check must stay a whole-title comparison: a bare product-name substring
  // would let an unrelated page satisfy it.
  assert.match(loader, /approvedTitles\.slice\(0, 2\)\.some\(\(title\) => html\.includes\(title\)\)/);
  assert.match(loader, /approvedTitles\.slice\(2\)\.some\(\(title\) => html\.includes\(title\)\)/);
  assert.match(loader, /Number\(legacyMarker\) \+ Number\(actionMarker\) !== 1/);
  assert.deepEqual(approvedTitles, [
    '<title>XUAN-投资管理</title>',
    '<title>XUAN-IB 睡前交接</title>',
    '<title>XUAN · 睡前行动版</title>',
    '<title>XUAN · 开市前行动版</title>',
    '<title>XUAN · 有限核实补读</title>',
    '<title>XUAN · 盘中数据更新</title>',
    '<title>XUAN · 已保存 EOD 摘要</title>',
    '<title>XUAN · Sharesight 记录摘要</title>',
  ]);

  // Exercise the loader's own predicate rather than restating it.
  const accepts = (html) => {
    const legacyMarker = html.includes('xuan-ib-handover:v1');
    const actionMarker = html.includes('xuan-ib-night-action-v1:');
    const legacy = legacyMarker && approvedTitles.slice(0, 2).some((title) => html.includes(title));
    const action = actionMarker && approvedTitles.slice(2).some((title) => html.includes(title));
    return Number(legacyMarker) + Number(actionMarker) === 1 && (legacy || action);
  };
  const marker = '<!-- xuan-ib-handover:v1 -->';
  assert.equal(accepts(`${marker}<title>XUAN-投资管理</title>`), true);
  assert.equal(accepts(`${marker}<title>XUAN-IB 睡前交接</title>`), true);
  assert.equal(accepts(`${marker}<title>XUAN-投资管理 摘要</title>`), false);
  assert.equal(accepts('<title>XUAN-投资管理</title>'), false);
  assert.equal(accepts('<!-- xuan-ib-night-action-v1:abc --><title>XUAN · 睡前行动版</title>'), true);
  assert.equal(accepts('<!-- xuan-ib-night-action-v1:abc --><title>XUAN · 开市前行动版</title>'), true);
  assert.equal(accepts(`${marker}<!-- xuan-ib-night-action-v1:abc --><title>XUAN · 睡前行动版</title>`), false);
});

test('the phone loader accepts an action header with a separate live status paragraph', async () => {
  const html = `<!doctype html><html><head><title>XUAN · 开市前行动版</title></head><body>
<!-- xuan-ib-night-action-v1:abc -->
<header><span class="state">已更新</span><h1>XUAN · 开市前行动版</h1><p>2026-09-28 · 2026-09-28 20:47–20:47 HKT · 数据至 2026-09-25 · 晚间版式预览，非定时发布</p><p class="state-detail" hidden></p></header>
<main>current-preopen-report</main></body></html>`;
  const meta = metaFor(html);
  const app = loaderHarness({
    now: '2026-09-28T13:47:00Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });

  await app.listeners.button.click();

  assert.match(app.frame.srcdoc, /current-preopen-report/);
  assert.match(app.status.textContent, /报告 09-28 开市前版 · 数据至 20:47/);
  assert.equal(app.warning.hidden, true);
  assert.equal(app.status.classList.contains('error'), false);
});

test('phone entry displays legacy and qualified recorded summaries without claiming complete or live data',async()=>{
 const legacy={schemaVersion:10,mode:'stored-eod-public-summary',status:'partial',dataDate:'2026-10-09',sourceDate:'2026-10-08',captureStartedAt:'2026-10-09T05:00:40.250Z',captureCompletedAt:'2026-10-09T05:00:53.024Z',risks:{reconciliation:'unknown',liveSource:'not-called'},unknowns:{orders:null,orderReserve:null,planning:null,executableBudget:null,availableFunds:null},concentration:{status:'observed',top1Pct:45,top5Pct:100}};
 for(const model of [legacy,qualifyRecordedPublicSummary(legacy)]){
  const html=renderPublicEodSummary(model),meta=metaFor(html);
  const app=loaderHarness({now:'2026-10-09T05:21:00Z',fetchImpl:async url=>String(url).includes('latest.meta.json')?response({json:meta,bytes:[]}):response({json:null,bytes:Buffer.from(html)})});
  await app.listeners.button.click();
  assert.equal(app.frame.srcdoc.slice(app.frame.srcdoc.indexOf('<body>')),html.slice(html.indexOf('<body>')));assert.match(app.frame.srcdoc,/Content-Security-Policy/);assert.match(app.frame.srcdoc,/script-src &apos;none&apos;/);
  assert.match(app.status.textContent,/Sharesight 记录至 2026-10-08/);assert.match(app.status.textContent,/未与券商完整核对/);assert.match(app.warning.textContent,/挂单和可执行预算仍待核实/);assert.equal(app.warning.classList.contains('error'),false);assert.equal(app.status.classList.contains('error'),false);
 }
});

test('validation and promotion accept a verified single-file candidate based on a trusted main ancestor', () => {
  // git for-each-ref treats a bare partial refname as a path component, not a prefix.
  // Keep the glob or the promoter silently sees zero Codex report branches.
  assert.ok(promotion.includes("'refs/remotes/origin/codex/xuan-ib-*'"));
  assert.match(validation, /git merge-base --is-ancestor "\$candidate_parent" origin\/main/);
  assert.match(validation, /git diff --name-only "\$candidate_parent\.\.HEAD"/);
  assert.match(validation, /git rev-list --first-parent --count/);
  assert.match(validation, /candidate_lag > 50/);
  assert.match(validation, /candidate_epoch < now_epoch - 172800/);
  assert.match(validation, /parent_epoch < now_epoch - 604800/);
  assert.match(validation, /candidate_parent" != "\$current_main/);
  assert.doesNotMatch(validation, /git rev-parse "HEAD\^"\) != "\$base_sha"/);
  assert.match(promotion, /if ! candidate_parent=\$\(git rev-parse "\$candidate_ref\^" 2>\/dev\/null\)/);
  assert.match(promotion, /git merge-base --is-ancestor "\$candidate_parent" origin\/main/);
  assert.match(promotion, /git diff --name-only "\$candidate_parent\.\.\$candidate_ref"/);
  assert.match(promotion, /git rev-list --first-parent --count/);
  assert.match(promotion, /candidate_lag > 50/);
  assert.match(promotion, /commit_epoch < now_epoch - 172800/);
  assert.match(promotion, /parent_epoch < now_epoch - 604800/);
  assert.match(promotion, /candidate_parent" != "\$base_sha/);
  assert.match(promotion, /if ! candidate_blob=\$\(git rev-parse "\$candidate_ref:xuan-ib\/index\.html" 2>\/dev\/null\)/);
  assert.match(promotion, /candidate_blob" == "\$published_blob/);
  assert.match(promotion, /git rev-list origin\/main -- xuan-ib\/latest\.html/);
  assert.match(promotion, /candidate_blob" == "\$historical_blob/);
  assert.match(promotion, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(promotion, /xuan-ib\/latest\.meta\.json/);
  assert.match(promotion, /xuan-ib-promotion\.mjs select/);
  assert.match(promotion, /if ! commit_api_json=\$\(curl --fail --silent --show-error/);
  assert.match(
    promotion,
    /candidate_guard=\(env -u XUAN_IB_ASSOCIATION_SNAPSHOT_JSON\s*\\\s*XUAN_IB_PREVIOUS_SOURCE_SHA="\$meta_source_sha"[\s\S]*?node scripts\/handover-guard\.mjs/
  );
  assert.match(promotion, /candidate_guard=\(env XUAN_IB_PREVIOUS_SOURCE_SHA="\$meta_source_sha" node scripts\/xuan-ib-night-action-guard\.mjs/);
  assert.match(promotion, /if ! "\$\{candidate_guard\[@\]\}"/);
  assert.match(promotion, /Skipping \$branch_name: its handover page failed validation/);
  assert.match(promotion, /git add xuan-ib\/latest\.html xuan-ib\/latest\.meta\.json/);
  assert.match(promotion, /Published metadata source is not a verified approved report commit/);
  assert.match(promotion, /contents\/xuan-ib\/index\.html\?ref=\$meta_source_sha/);
  assert.match(promotion, /refs\/tags\/xuan-ib-published\/\$\{source_data_date\}/);
  assert.match(promotion, /refs\/tags\/xuan-ib-published\/\$\{DATA_DATE\}/);
  assert.doesNotMatch(promotion, /published_commit_epoch/);
  assert.doesNotMatch(promotion, /multiple valid handovers are waiting/);
  assert.doesNotMatch(promotion, /git merge-base --is-ancestor origin\/main "\$candidate_ref"/);
});

test('trusted publication metadata matches the currently published Git blob', () => {
  assert.equal(metadata.schemaVersion, 1);
  assert.match(metadata.sourceSha, /^[0-9a-f]{40}$/);
  assert.match(metadata.htmlBlob, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(metadata.sourceCommitEpoch) && metadata.sourceCommitEpoch > 0);
  assert.match(metadata.dataDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(metadata.htmlBlob, gitBlobSha(latestBytes));
  assert.equal(metadata.dataDate, primaryDate(latest));
});

test('the UI check delegates XUAN-IB publication locking to the single base-controlled policy check', () => {
  assert.doesNotMatch(uiPrCheck, /Block direct replacement of the published XUAN-IB page/);
  assert.doesNotMatch(uiPrCheck, /latest\\\.meta\\\.json/);
  assert.match(uiPrCheck, /ui-pr-guard\.mjs/);
});

test('a base-controlled policy lock protects the publication code itself', () => {
  assert.match(policyLock, /pull_request_target/);
  assert.match(policyLock, /'xuan-ib-policy-lock'/);
  assert.match(policyLock, /workflows\//);
  assert.match(policyLock, /handover-guard/);
  assert.match(policyLock, /xuan-ib\//);
  assert.match(policyLock, /\.github\/\(CODEOWNERS\$\|workflows\/\|actions\/\)/);
  assert.match(policyLock, /previous_filename/);
  assert.match(policyLock, /EXPECTED_FILE_COUNT/);
  assert.match(policyLock, /returned_file_count > 1000/);
  assert.match(policyLock, /issues: read/);
  assert.match(policyLock, /\/approve-xuan-ib-maintenance \$head_sha/);
  assert.match(policyLock, /author_association == "OWNER"/);
  assert.match(policyLock, /approval is invalidated automatically by every new commit/);
  const steps = policyLock.split(/^      - name: /m).slice(1);
  const checkout = steps.filter(step => step.includes('uses: actions/checkout@'));
  assert.equal(checkout.length, 1, 'exactly one trusted-base checkout is allowed');
  assert.match(checkout[0], /^Check out the trusted policy implementation\n/);
  assert.match(checkout[0], /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
  assert.match(checkout[0], /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(checkout[0], /ref:.*(?:head|refs\/pull|FETCH_HEAD)/i);
  assert.doesNotMatch(policyLock, /git\s+(?:checkout|switch|reset)|write-all|id-token: write/);
  const permissions = policyLock.match(/^permissions:\n((?:  [^\n]+\n)+)/m)?.[1];
  assert.equal(permissions, '  contents: read\n  issues: read\n  pull-requests: read\n');
  const ordinary = steps.find(step => step.startsWith('Verify registered ordinary changes and signed executor\n'));
  assert.ok(ordinary, 'trusted-base verifier must enforce the delegated lane');
  assert.match(ordinary, /git fetch --no-tags origin "\$HEAD_SHA"/);
  assert.match(ordinary, /node scripts\/approval-tier-plan\.mjs "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.doesNotMatch(ordinary, /(?:git show|git cat-file)[^\n]*\|\s*(?:node|bash|sh|python)/);
  assert.doesNotMatch(ordinary, /(?:node|bash|sh|python)\s+[^\n]*(?:FETCH_HEAD|HEAD_SHA[:/])/);
});

test('draft pull requests stay quiet until ready, then every blocking check runs', () => {
  assert.match(policyLock, /name: \$\{\{ github\.event\.pull_request\.draft && 'xuan-ib-policy-lock-draft-notice' \|\| 'xuan-ib-policy-lock' \}\}/);
  assert.match(scriptsCheck, /name: \$\{\{ github\.event\.pull_request\.draft && 'scripts-check-draft-notice' \|\| 'scripts-check' \}\}/);
  assert.match(policyLock, /Explain deferred enforcement for draft pull requests[\s\S]*draft == true/);
  const ownerFallback = policyLock.split(/^      - name: /m)
    .find(step => step.startsWith('Require specific owner approval outside the ordinary exception\n'));
  assert.ok(ownerFallback, 'non-ordinary or failed verification must run OWNER fallback');
  assert.match(ownerFallback, /if: \$\{\{ github\.event\.pull_request\.draft == false && steps\.ordinary\.outcome != 'success' \}\}/);
  assert.match(ownerFallback, /approval_line="\/approve-xuan-ib-maintenance \$head_sha"/);
  assert.match(ownerFallback, /author_association == "OWNER"/);
  assert.match(ownerFallback, /\.user\.id == 283054367/);
  assert.match(ownerFallback, /index\(\$approval_line\)/);
  assert.match(policyLock, /ready_for_review/);
  assert.match(scriptsCheck, /ready_for_review/);
  assert.match(scriptsCheck, /Explain deferred validation for draft pull requests[\s\S]*draft == true/);
  assert.match(scriptsCheck, /Check out the proposed merge[\s\S]*draft == false/);
  assert.match(scriptsCheck, /Verify append-only implementation progress[\s\S]*draft == false/);
  assert.match(scriptsCheck, /Test implementation progress and classification audit[\s\S]*draft == false/);
  assert.match(scriptsCheck, /Run the script test suite[\s\S]*draft == false/);
});

test('the variable report stays separate from the fixed loader', () => {
  assert.match(latest, /<!--\s*(?:xuan-ib-handover:v1\s*|xuan-ib-night-action-v1:[A-Za-z0-9_-]+\s*)-->/);
  const publishedTitle = latest.match(/<title>[^<]*<\/title>/);
  assert.ok(publishedTitle, 'the published handover must carry a title');
  assert.ok(
    approvedTitles.includes(publishedTitle[0]),
    `the published title ${publishedTitle[0]} is not one the loader accepts`
  );
  if (!latest.includes('xuan-ib-night-action-v1:')) assert.match(latest, /apple-mobile-web-app-capable/);
  assert.match(policyLock, /proposed-xuan-index\.html/);
  assert.match(policyLock, /A variable XUAN-IB report cannot replace the stable phone loader/);
  assert.match(policyLock, /new URL\(\"latest\.meta\.json\", location\.href\)/);
  assert.match(policyLock, /new URL\(\"latest\.html\", location\.href\)/);
});

// The progress-panel scenarios that replayed the published 2026-09-05 archive were removed with that archive
// on 2026-11-17 (owner decision: the plaintext historical page is no longer published or kept in the tree).

test('retired manual report entry is absent; only decision Shortcut remains', () => {
  assert.doesNotMatch(loader, /id="(?:adhoc|stop-adhoc)"|beginAdhocWait|adhocShortcutUrl/);
  assert.doesNotMatch(loader, /%E4%B8%B4%E6%97%B6%E6%8A%A5%E5%91%8A/);
  assert.match(loader, /decisionButton.addEventListener/);
});
test('obsolete generation wait is removed without dropping verified data or decision receipts', async () => {
  for (const saved of ['{}', 'invalid-json']) {
    const stored = new Map([['xuan-ib:adhoc-wait:v1', saved]]);
    const html = reportHtml('2026-08-28', '早间版', decisionTemplate({decisions:[awaitingDecision()]}));
    const meta = metaFor(html);
    const app = loaderHarness({stored,fetchImpl:async url=>String(url).includes('latest.meta.json')
      ? response({json:meta,bytes:[]}) : response({json:null,bytes:Buffer.from(html)})});
    await app.listeners.button.click();
    assert.equal(stored.has('xuan-ib:adhoc-wait:v1'),false);
    assert.ok(stored.has('xuan-ib:last-verified:v1'));
    assert.equal(app.navigations.length,0);
    app.listeners.decision.click({preventDefault(){}});
    assert.ok(stored.has('xuan-ib:decision-wait:v1'));
    assert.equal(app.navigations.length,1);
  }
});

test('hidden wrapper retains verified report loading and background-check status without generating data', async () => {
  const html = reportHtml('2026-08-28', '睡前版', '<p>Verified report remains visible</p>');
  const meta = metaFor(html), requests = [];
  const app = loaderHarness({fetchImpl: async url => {
    requests.push(String(url));
    return String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []}) : response({bytes: Buffer.from(html)});
  }});
  await app.listeners.button.click();
  assert.match(app.frame.srcdoc, /Verified report remains visible/);
  assert.match(app.status.textContent, /已检查/);
  assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html, html);
  assert.ok(requests.every(url => /latest\.(?:meta\.json|html)/.test(url)));
  assert.equal(app.navigations.length, 0);
});
