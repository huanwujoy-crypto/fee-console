import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';



const loader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
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
  const match = html.match(/<span class="date">(\d{4}-\d{2}-\d{2})\b/);
  assert.ok(match, 'the published handover must carry a primary data date');
  return match[1];
};
const promotion = fs.readFileSync(new URL('../.github/workflows/promote-xuan-ib-handover.yml', import.meta.url), 'utf8');
const validation = fs.readFileSync(new URL('../.github/workflows/validate-xuan-ib-handover.yml', import.meta.url), 'utf8');
const uiPrCheck = fs.readFileSync(new URL('../.github/workflows/ui-pr-check.yml', import.meta.url), 'utf8');
const policyLock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
const metadata = JSON.parse(fs.readFileSync(new URL('../xuan-ib/latest.meta.json', import.meta.url), 'utf8'));

test('promotion commits the derived decision menu with its paired report and metadata', () => {
  assert.match(promotion, /xuan-ib-decision-menu\.mjs publish-manifest/);
  assert.match(promotion, /git add xuan-ib\/latest\.html xuan-ib\/latest\.meta\.json xuan-ib\/latest\.decisions\.json/);
  assert.match(policyLock, /xuan-ib-decision-menu\|build-xuan-decision-shortcut/);
});

const inlineScript = loader.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'the phone loader must contain one executable inline script');

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
  for (let index = 1; index <= 4; index += 1) {
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

function loaderHarness({fetchImpl, stored = new Map(), now = '2026-08-28T06:00:00Z', displayDom = false}) {
  const listeners = {adhoc: {}, decision: {}, button: {}, window: {}, document: {}};
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
    addEventListener: (name, callback) => { listeners.adhoc[name] = callback; },
  };
  const button = {
    disabled: false,
    addEventListener: (name, callback) => { listeners.button[name] = callback; },
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
  const warning = {hidden: true, textContent: '上游暂不一致，正在显示上一份已验证版本'};
  const elements = new Map([
    ['#adhoc', adhoc],
    ['#decision', decision],
    ['#decision-count', decisionCount],
    ['#handover', frame],
    ['#refresh', button],
    ['#status', status],
    ['#warning', warning],
  ]);
  const localStorage = {
    setItem: (key, value) => stored.set(key, String(value)),
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
  const location = {href: 'https://example.test/xuan-ib/'};
  const context = {
    AbortController,
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
  };
  vm.runInNewContext(inlineScript, context);
  return {
    adhoc,
    advanceTime: (milliseconds) => { nowEpoch += milliseconds; },
    button,
    decision,
    decisionAttributes,
    decisionCount,
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
  assert.match(loader, /Date\.now\(\) - lastAttempt > 5 \* 60_000/);
  assert.match(loader, /visibilitychange/);
  assert.match(loader, /button\.addEventListener\("click", loadLatest\)/);
  assert.match(loader, /record\.info\.dataDate/);
  assert.match(loader, /record\.info\.edition/);
  assert.match(loader, /loaderBuild = "2026-08-31\.4"/);
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

test('the ad-hoc report control runs the private iPhone Shortcut without embedding credentials', () => {
  const link = loader.match(/<a id="adhoc"[\s\S]*?<\/a>/)?.[0];
  assert.ok(link, 'the fixed phone header must offer an ad-hoc report control');
  assert.match(
    link,
    /href="shortcuts:\/\/run-shortcut\?name=XUAN-IB%20%E4%B8%B4%E6%97%B6%E6%8A%A5%E5%91%8A"/
  );
  assert.doesNotMatch(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, />生成临时报告</);
  assert.match(link, /一键启动 · 自动刷新/);
  assert.doesNotMatch(link, /[?&](?:token|secret|api[_-]?key)=/i);
  assert.doesNotMatch(loader, /sk-ant-oat01-/);
  assert.doesNotMatch(loader, /api\.anthropic\.com\/v1\/claude_code\/routines/);
  assert.match(loader, /adhocButton\.addEventListener\("click", beginAdhocWait\)/);
  assert.match(loader, /临时报告正在生成，请稍候/);
  assert.match(loader, /临时报告已完成/);
  assert.match(loader, /waitPollMs = 15_000/);
  assert.match(loader, /xuan-ib:adhoc-wait:v1/);
  assert.match(loader, /window\.addEventListener\("focus"/);
  assert.match(loader, /if \(activeWait\(\) && !expireWaits\(\)\) return loadLatest\(\)/);
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
  assert.equal(fold.querySelector('summary').textContent, '待决定事项2 项');
  assert.equal(app.decision, originalButton, 'move the parent-owned element, never clone a report action');
  assert.equal(app.decision.parentElement, row, 'button is a sibling of the fold, not inside its summary');
  assert.equal(app.decision.ownerDocument, fixture.doc);
  assert.equal(app.decisionCount.ownerDocument, fixture.doc, 'adoption includes the count');
  assert.equal(app.listeners.decision.click, originalListener, 'parent callback survives document adoption');
  assert.deepEqual(body.children, originalCards.slice(0, 2));
  assert.equal(originalCards[2].parentElement, fixture.card, 'already-decided items stay outside pending');
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
  for (const item of decisions) assert.equal(fixture.doc.getElementById(item.decisionId).parentElement, fixture.card);
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
  assert.match(app.status.textContent, /^请先刷新并确认当前待办/);

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
  assert.equal(app.status.textContent, '回应已记录，报告已自动刷新');
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
  assert.equal(app.status.textContent, '回应已记录，报告已自动刷新');
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
  assert.equal(app.status.textContent, '尚未收到回应回执，请稍后刷新 · L 2026-08-31.4');
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

test('ad-hoc and decision waits are mutually exclusive and share one refresh loop', async () => {
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
  await app.listeners.adhoc.click();
  assert.ok(app.stored.has('xuan-ib:adhoc-wait:v1'));

  await app.listeners.decision.click({preventDefault: () => {}});
  assert.equal(app.stored.has('xuan-ib:adhoc-wait:v1'), false);
  assert.ok(app.stored.has('xuan-ib:decision-wait:v1'));

  await app.listeners.adhoc.click();
  assert.ok(app.stored.has('xuan-ib:adhoc-wait:v1'));
  assert.equal(app.stored.has('xuan-ib:decision-wait:v1'), false);
  assert.equal(app.intervals.filter(({delay}) => delay === 15_000).length, 1);
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

test('the ad-hoc launcher waits for a newly verified publication and then renders it automatically', async () => {
  const firstHtml = reportHtml('2026-08-28', '早间版', 'before-ad-hoc');
  const firstMeta = metaFor(firstHtml, {sourceCommitEpoch: 1_788_000_000});
  const nextHtml = reportHtml('2026-08-28', '临时版', 'completed-ad-hoc');
  const nextMeta = metaFor(nextHtml, {sourceCommitEpoch: 1_788_000_060});
  let current = {html: firstHtml, meta: firstMeta};
  const requests = [];
  const app = loaderHarness({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return String(url).includes('latest.meta.json')
        ? response({json: current.meta, bytes: []})
        : response({json: null, bytes: Buffer.from(current.html)});
    },
  });

  await app.listeners.button.click();
  assert.match(app.frame.srcdoc, /before-ad-hoc/);

  await app.listeners.adhoc.click();
  assert.match(app.status.textContent, /^临时报告正在生成，请稍候/);
  assert.ok(app.stored.has('xuan-ib:adhoc-wait:v1'));
  assert.match(app.frame.srcdoc, /before-ad-hoc/);

  current = {html: nextHtml, meta: nextMeta};
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  assert.ok(poll, 'the loader must poll while an ad-hoc report is pending');
  await poll.callback();

  assert.match(app.frame.srcdoc, /completed-ad-hoc/);
  assert.equal(app.status.textContent, '临时报告已完成 · 已自动刷新');
  assert.equal(app.stored.has('xuan-ib:adhoc-wait:v1'), false);
  assert.equal(requests.filter((url) => url.includes('latest.meta.json')).length, 3);
  assert.equal(requests.filter((url) => url.includes('latest.html')).length, 3);
});

test('the ad-hoc wait survives a phone page reload and never treats the baseline as complete', async () => {
  const html = reportHtml('2026-08-28', '早间版', 'same-baseline');
  const meta = metaFor(html, {sourceCommitEpoch: 1_788_000_000});
  const stored = new Map();
  const fetchImpl = async (url) => String(url).includes('latest.meta.json')
    ? response({json: meta, bytes: []})
    : response({json: null, bytes: Buffer.from(html)});
  const first = loaderHarness({fetchImpl, stored});
  await first.listeners.button.click();
  await first.listeners.adhoc.click();
  assert.ok(stored.has('xuan-ib:adhoc-wait:v1'));

  const reloaded = loaderHarness({fetchImpl, stored});
  assert.match(reloaded.status.textContent, /^临时报告正在生成，请稍候/);
  await reloaded.listeners.button.click();
  assert.match(reloaded.status.textContent, /^临时报告正在生成，请稍候/);
  assert.match(reloaded.frame.srcdoc, /same-baseline/);
  assert.ok(stored.has('xuan-ib:adhoc-wait:v1'));
});

test('a newer scheduled publication cannot falsely complete an ad-hoc request', async () => {
  const firstHtml = reportHtml('2026-08-28', '早间版', 'before-request');
  const firstMeta = metaFor(firstHtml, {sourceCommitEpoch: 1_788_000_000});
  const scheduledHtml = reportHtml('2026-08-28', '睡前版', 'new-scheduled-report');
  const scheduledMeta = metaFor(scheduledHtml, {sourceCommitEpoch: 1_788_000_060});
  let current = {html: firstHtml, meta: firstMeta};
  const app = loaderHarness({
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: current.meta, bytes: []})
      : response({json: null, bytes: Buffer.from(current.html)}),
  });
  await app.listeners.button.click();
  await app.listeners.adhoc.click();

  current = {html: scheduledHtml, meta: scheduledMeta};
  const poll = app.intervals.find(({delay}) => delay === 15_000);
  await poll.callback();

  assert.match(app.frame.srcdoc, /new-scheduled-report/);
  assert.match(app.status.textContent, /^临时报告正在生成，请稍候/);
  assert.ok(app.stored.has('xuan-ib:adhoc-wait:v1'));
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
  assert.match(app.status.textContent, /^已同步 \d{2}:\d{2}$/);
  assert.doesNotMatch(app.status.textContent, /报告|睡前版|\bL\b/);
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
  assert.match(app.warning.textContent, /报告已过期/);
  assert.match(app.warning.textContent, /应至少为 2026-08-28 睡前版/);
  assert.match(app.warning.textContent, /当前为 2026-08-27 睡前版/);
  assert.match(app.warning.textContent, /未伪造新数据/);
  assert.equal(app.status.classList.contains('error'), true);
});

test('Saturday AM remains current through Sunday and Monday before the PM deadline', async () => {
  const html = reportHtml('2026-08-29', '早间版', 'trusted-saturday-am');
  const meta = metaFor(html);
  for (const now of ['2026-08-29T00:35:00Z', '2026-08-30T12:00:00Z', '2026-08-31T13:24:00Z']) {
    const app = loaderHarness({
      now,
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(app.warning.hidden, true, `${now} must accept the last Saturday AM report`);
    assert.equal(app.status.classList.contains('error'), false);
  }
});

test('Hong Kong SLA advances at Tuesday-Saturday 08:35 and Monday-Friday 21:25', async () => {
  const cases = [
    ['2026-09-01T00:34:00Z', '2026-08-31', '睡前版', false], // Tue 08:34 HKT
    ['2026-09-01T00:35:00Z', '2026-08-31', '睡前版', true],  // Tue 08:35 HKT
    ['2026-09-01T00:35:00Z', '2026-09-01', '早间版', false],
    ['2026-09-01T13:25:00Z', '2026-09-01', '早间版', true],  // Tue 21:25 HKT
    ['2026-09-01T13:25:00Z', '2026-09-01', '睡前版', false],
    ['2026-09-05T00:34:00Z', '2026-09-04', '睡前版', false], // Sat 08:34 HKT
    ['2026-09-05T00:35:00Z', '2026-09-04', '睡前版', true],
    ['2026-09-05T00:35:00Z', '2026-09-05', '早间版', false],
  ];
  for (const [now, date, edition, stale] of cases) {
    const html = reportHtml(date, edition, `${date}-${edition}`);
    const meta = metaFor(html);
    const app = loaderHarness({
      now,
      fetchImpl: async (url) => String(url).includes('latest.meta.json')
        ? response({json: meta, bytes: []})
        : response({json: null, bytes: Buffer.from(html)}),
    });
    await app.listeners.button.click();
    assert.equal(!app.warning.hidden, stale, `${now} / ${date} / ${edition}`);
  }
});

test('a newer ad-hoc report can be the phone page without impersonating the scheduled history', async () => {
  const html = reportHtml('2026-09-01', '计划外加跑（常规 21:00）', 'trusted-adhoc');
  const meta = metaFor(html, {sourceCommitEpoch: Date.parse('2026-09-01T13:05:00Z') / 1000});
  const app = loaderHarness({
    now: '2026-09-01T13:25:00Z',
    fetchImpl: async (url) => String(url).includes('latest.meta.json')
      ? response({json: meta, bytes: []})
      : response({json: null, bytes: Buffer.from(html)}),
  });
  await app.listeners.button.click();
  assert.match(app.frame.srcdoc, /trusted-adhoc/);
  assert.equal(app.warning.hidden, true);
  assert.equal(app.status.classList.contains('error'), false);
});

test('an ad-hoc report created before a newly due slot is marked stale after that deadline', async () => {
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
  assert.match(app.warning.textContent, /应至少为 2026-09-01 睡前版/);
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
  assert.equal(app.status.textContent, '显示上一份已验证版本 · 2026-08-27 睡前版');
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
  assert.equal(app.status.textContent, '显示上一份已验证版本 · 2026-08-27 早间版');
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

test('the integrity check accepts both titles for the length of the rename', () => {
  // The check must stay a whole-title comparison: a bare product-name substring
  // would let an unrelated page satisfy it.
  assert.match(loader, /!approvedTitles\.some\(\(title\) => html\.includes\(title\)\)/);
  assert.match(loader, /!html\.includes\("xuan-ib-handover:v1"\)/);
  assert.deepEqual(approvedTitles, [
    '<title>XUAN-投资管理</title>',
    '<title>XUAN-IB 睡前交接</title>',
  ]);

  // Exercise the loader's own predicate rather than restating it.
  const accepts = (html) =>
    html.includes('xuan-ib-handover:v1') &&
    approvedTitles.some((title) => html.includes(title));
  const marker = '<!-- xuan-ib-handover:v1 -->';
  assert.equal(accepts(`${marker}<title>XUAN-投资管理</title>`), true);
  assert.equal(accepts(`${marker}<title>XUAN-IB 睡前交接</title>`), true);
  assert.equal(accepts(`${marker}<title>XUAN-投资管理 摘要</title>`), false);
  assert.equal(accepts('<title>XUAN-投资管理</title>'), false);
});

test('validation and promotion accept a verified single-file candidate based on a trusted main ancestor', () => {
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
    /if ! XUAN_IB_PREVIOUS_SOURCE_SHA="\$meta_source_sha"[\s\S]*?node scripts\/handover-guard\.mjs/
  );
  assert.match(promotion, /Skipping \$branch_name: its handover page failed validation/);
  assert.match(promotion, /git add xuan-ib\/latest\.html xuan-ib\/latest\.meta\.json/);
  assert.match(promotion, /Published metadata source is not a verified Claude commit/);
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
  assert.match(policyLock, /name: xuan-ib-policy-lock/);
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
  assert.doesNotMatch(policyLock, /actions\/checkout/);
});

test('the variable handover stays separate from the fixed loader', () => {
  assert.match(latest, /<!--\s*xuan-ib-handover:v1\s*-->/);
  const publishedTitle = latest.match(/<title>[^<]*<\/title>/);
  assert.ok(publishedTitle, 'the published handover must carry a title');
  assert.ok(
    approvedTitles.includes(publishedTitle[0]),
    `the published title ${publishedTitle[0]} is not one the loader accepts`
  );
  assert.match(latest, /apple-mobile-web-app-capable/);
});

const progressFixture = JSON.parse(fs.readFileSync(new URL('../xuan-ib/implementation-progress.json',import.meta.url),'utf8'));
const progressFollowup = new Date(Date.parse(progressFixture.events.at(-1).recordedAtHkt)+60000+28800000).toISOString().slice(0,19)+'+08:00';
const progressTestNow = new Date(Date.parse(progressFollowup)+60000).toISOString();
const publishedState = JSON.parse(latest.match(/<template id="xuan-ib-decision-state-v1"[^>]*>([\s\S]*?)<\/template>/)[1]);
const settleProgress = () => new Promise(resolve => setTimeout(resolve, 15));
function progressApp(getProgress) {
  let current = {html:latest,meta:metadata};
  const app=loaderHarness({now:progressTestNow,displayDom:true,fetchImpl:async(url,opts)=>{
    if(String(url).includes('implementation-progress.json')) {
      assert.equal(opts.cache,'no-store');assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');
      return getProgress();
    }
    return String(url).includes('latest.meta.json') ? response({json:current.meta,bytes:[]})
      : response({bytes:Buffer.from(current.html)});
  }});
  return {app,setReport:value=>{current=value;}};
}
test('independent progress refresh updates the same report without resetting original cards or selected tab',async()=>{
  let data=structuredClone(progressFixture);
  const {app}=progressApp(()=>response({bytes:Buffer.from(JSON.stringify(data))}));
  await app.listeners.button.click();
  const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);
  await settleProgress();
  assert.equal(doc.querySelectorAll('.xuan-work').length,3);
  assert.match(doc.getElementById('progress-'+data.events[0].decisionId).textContent,/临时处理已生效/);
  const history=doc.querySelector('.xuan-work-original');history.setAttribute('open','');
  doc.getElementById('s4').checked=true;
  const writes=app.frame.srcdocWrites;
  data.revision++;
  data.events.push({...structuredClone(data.events[0]),eventId:'P-UPDATE',recordedAtHkt:progressFollowup,summary:'新进度已核对'});
  await app.listeners.button.click();await settleProgress();
  assert.equal(app.frame.srcdocWrites,writes);
  assert.equal(doc.getElementById('s4').checked,true);
  assert.equal(history.hasAttribute('open'),true);
  assert.match(doc.getElementById('progress-'+data.events[0].decisionId).textContent,/新进度已核对/);
  assert.equal(doc.querySelectorAll('.xuan-work').length,3);
  assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html,latest);
});
test('progress failure removes current-status claims without damaging the financial report or immutable receipt DOM',async()=>{
  let bad=false;
  const {app}=progressApp(()=>response({status:bad?404:200,bytes:Buffer.from(JSON.stringify(progressFixture))}));
  await app.listeners.button.click();
  const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);await settleProgress();
  bad=true;await app.listeners.button.click();await settleProgress();
  assert.match(doc.getElementById('xuan-progress-status').textContent,/暂不可用/);
  assert.match(doc.querySelector('.xuan-work-current').textContent,/当前进度未核实/);
  assert.equal(app.status.classList.contains('error'),false);
  assert.equal(app.decision.disabled,true);
  assert.ok(doc.getElementById(progressFixture.events[0].decisionId));
});
test('GOOG scope confirmation clears the extra approval notice on same-report refresh while preserving its history',async()=>{
  const confirmationIndex=progressFixture.events.findIndex(e=>e.eventId==='P-20260831-5');
  assert.ok(confirmationIndex>0);
  let data={...structuredClone(progressFixture),revision:2,events:structuredClone(progressFixture.events.slice(0,confirmationIndex))};
  const {app}=progressApp(()=>response({bytes:Buffer.from(JSON.stringify(data))}));
  await app.listeners.button.click();
  const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);await settleProgress();
  const id='D-20260829-GOOG-FAMILY-LIMIT';
  const original=doc.getElementById(id), originalText=original.textContent;
  const writes=app.frame.srcdocWrites;
  assert.match(doc.getElementById('xuan-progress-status').textContent,/1 项后续规则待你确认/);
  data=structuredClone(progressFixture);
  await app.listeners.button.click();await settleProgress();
  assert.equal(app.frame.srcdocWrites,writes);
  assert.equal(doc.getElementById(id),original);
  assert.equal(original.textContent,originalText);
  const current=doc.getElementById('progress-'+id).querySelector('.xuan-work-current');
  assert.match(current.textContent,/双视图已确认，等待新版核验/);
  assert.doesNotMatch(current.textContent,/待你确认规则|等你确认/);
  assert.doesNotMatch(doc.getElementById('xuan-progress-status').textContent,/后续规则待你确认/);
  assert.equal(app.decision.disabled,true);
  assert.equal(JSON.parse(app.stored.get('xuan-ib:last-verified:v1')).html,latest);
});
test('new report cannot inherit a current verified status from an older observed pair',async()=>{
  const {app,setReport}=progressApp(()=>response({bytes:Buffer.from(JSON.stringify(progressFixture))}));
  await app.listeners.button.click();
  app.loadFrame(todoDocument(app.frame.srcdoc,publishedState.decisions).doc);await settleProgress();
  const updated=latest.replace('</body>','<p>new financial report test</p></body>');
  setReport({html:updated,meta:metaFor(updated,{sourceSha:'a'.repeat(40),sourceCommitEpoch:metadata.sourceCommitEpoch+60})});
  await app.listeners.button.click();
  const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);await settleProgress();
  assert.equal(doc.querySelectorAll('.xuan-work-badge').length,3);
  for(const badge of doc.querySelectorAll('.xuan-work-badge')) assert.match(badge.textContent,/历史进度 · 本期尚未复核/);
});
test('wrong receipt and malformed progress fail closed independently',async()=>{
  for(const mode of ['receipt','json']) {
    const d=structuredClone(progressFixture);d.events[0].receiptId='R-20260831-000000-XXXXXXXX';
    const {app}=progressApp(()=>response({bytes:Buffer.from(mode==='json'?'{"x":1,"x":2}':JSON.stringify(d))}));
    await app.listeners.button.click();
    const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);await settleProgress();
    assert.match(doc.getElementById('xuan-progress-status').textContent,/暂不可用/);
    assert.equal(doc.querySelectorAll('.xuan-work').length,0);
    assert.match(app.status.textContent,/已同步/);
  }
});
test('a stalled progress request neither blocks the report nor lets late earlier results overwrite a newer ledger',async()=>{
  let release;let calls=0;
  const newer=structuredClone(progressFixture);newer.revision++;
  newer.events.push({...structuredClone(newer.events[0]),eventId:'P-NEWEST',recordedAtHkt:progressFollowup,summary:'较新进度'});
  const {app}=progressApp(()=>{
    calls++;
    if(calls===1) return new Promise(resolve=>{release=resolve;});
    return response({bytes:Buffer.from(JSON.stringify(newer))});
  });
  await app.listeners.button.click();assert.equal(app.button.disabled,false);
  const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);app.loadFrame(doc);
  await app.listeners.button.click();await settleProgress();
  release(response({bytes:Buffer.from(JSON.stringify(progressFixture))}));await settleProgress();
  assert.ok(doc.getElementById('xuan-progress-status').textContent.includes('版本 '+newer.revision));
  assert.match(doc.querySelector('.xuan-work-current').textContent,/较新进度/);
});

test('candidate-owned progress class or reserved ID never authorizes replacement of original text',async()=>{
  for(const mode of ['class','id']) {
    const {app}=progressApp(()=>response({bytes:Buffer.from(JSON.stringify(progressFixture))}));
    await app.listeners.button.click();
    const {doc}=todoDocument(app.frame.srcdoc,publishedState.decisions);
    const original=doc.getElementById(progressFixture.events[0].decisionId);
    const fact=doc.createElement('p');fact.textContent='Original fact must survive';
    if(mode==='class') fact.className='xuan-work-current';
    else fact.id='progress-'+progressFixture.events[0].decisionId;
    original.append(fact);
    app.loadFrame(doc);await settleProgress();
    assert.ok(original.contains(fact));
    assert.equal(fact.textContent,'Original fact must survive');
    if(mode==='id') assert.equal(doc.querySelectorAll('.xuan-work').length,0);
  }
});
