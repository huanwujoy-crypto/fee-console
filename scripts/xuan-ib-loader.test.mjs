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

function loaderHarness({fetchImpl, stored = new Map(), now = '2026-08-28T06:00:00Z'}) {
  const listeners = {adhoc: {}, decision: {}, button: {}, window: {}, document: {}};
  const intervals = [];
  const frame = {srcdoc: ''};
  const adhoc = {
    addEventListener: (name, callback) => { listeners.adhoc[name] = callback; },
  };
  const button = {
    disabled: false,
    addEventListener: (name, callback) => { listeners.button[name] = callback; },
  };
  const decisionAttributes = new Map();
  const decision = {
    hidden: true,
    addEventListener: (name, callback) => { listeners.decision[name] = callback; },
    setAttribute: (name, value) => decisionAttributes.set(name, String(value)),
  };
  const decisionCount = {textContent: '0'};
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
  assert.match(loader, /loaderBuild = "2026-08-30\.1"/);
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
  const link = loader.match(/<a id="decision"[\s\S]*?<\/a>/)?.[0];
  assert.ok(link, 'the outer loader must contain the decision launcher');
  assert.match(
    link,
    /href="shortcuts:\/\/run-shortcut\?name=XUAN-IB%20%E5%9B%9E%E5%BA%94%E5%BE%85%E5%8A%9E"/
  );
  assert.match(link, /hidden/);
  assert.match(link, /回应待办/);
  assert.doesNotMatch(link, /target="_blank"/);
  assert.doesNotMatch(link, /decisionId|sourceSha|htmlBlob|publicSummary|token|secret|api[_-]?key/i);
  assert.match(loader, /xuan-ib:decision-wait:v1/);
  assert.match(loader, /waitTimeoutMs = 20 \* 60_000/);
  assert.match(loader, /decisionButton\.addEventListener\("click", beginDecisionWait\)/);
  assert.match(loader, /event\.preventDefault\(\)/);
  assert.match(loader, /location\.href = decisionShortcutUrl/);
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
  }
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
  assert.match(app.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
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
  assert.match(app.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
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
  assert.match(app.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
  assert.ok(app.stored.has('xuan-ib:decision-wait:v1'));

  app.advanceTime(20 * 60_000 + 1);
  await poll.callback();
  assert.equal(app.status.textContent, '尚未收到回应回执，请稍后刷新 · L 2026-08-30.1');
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
  assert.match(app.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
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
  assert.match(reloaded.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
  await reloaded.listeners.window.pageshow({persisted: true});
  assert.match(reloaded.frame.srcdoc, /xuan-ib-decision-state-v1/);
  assert.match(reloaded.status.textContent, /^已进入 Claude，请在 App 内完成选择/);
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
