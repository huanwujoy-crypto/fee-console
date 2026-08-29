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
  const listeners = {adhoc: {}, button: {}, window: {}, document: {}};
  const intervals = [];
  const frame = {srcdoc: ''};
  const adhoc = {
    addEventListener: (name, callback) => { listeners.adhoc[name] = callback; },
  };
  const button = {
    disabled: false,
    addEventListener: (name, callback) => { listeners.button[name] = callback; },
  };
  const status = {textContent: '', classList: classList()};
  const warning = {hidden: true, textContent: '上游暂不一致，正在显示上一份已验证版本'};
  const elements = new Map([
    ['#adhoc', adhoc],
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
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new NativeDate(now).getTime(); }
  }
  const context = {
    AbortController,
    Array,
    Date: FixedDate,
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
    location: {href: 'https://example.test/xuan-ib/'},
    window,
  };
  vm.runInNewContext(inlineScript, context);
  return {adhoc, button, frame, intervals, listeners, status, stored, warning, warnings};
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
  assert.match(loader, /lastSuccess = Date\.now\(\);/);
  assert.match(loader, /if \(request !== requestSequence\) return/);
  assert.match(loader, /lastAttempt = Date\.now\(\)/);
  assert.match(loader, /Date\.now\(\) - lastAttempt > 5 \* 60_000/);
  assert.match(loader, /visibilitychange/);
  assert.match(loader, /button\.addEventListener\("click", loadLatest\)/);
  assert.match(loader, /record\.info\.dataDate/);
  assert.match(loader, /record\.info\.edition/);
  assert.match(loader, /loaderBuild = "2026-08-29\.4"/);
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

test('the ad-hoc report control opens the verified Claude routine without embedding credentials', () => {
  const link = loader.match(/<a id="adhoc"[\s\S]*?<\/a>/)?.[0];
  assert.ok(link, 'the fixed phone header must offer an ad-hoc report control');
  assert.match(
    link,
    /href="https:\/\/claude\.ai\/code\/routines\/trig_0119mP9Z1F9f8QuwMsRLWL7Y"/
  );
  assert.doesNotMatch(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, />生成临时报告</);
  assert.match(link, /打开 Claude → Run now/);
  assert.doesNotMatch(link, /[?&](?:token|secret|api[_-]?key)=/i);
  assert.match(loader, /adhocButton\.addEventListener\("click", beginAdhocWait\)/);
  assert.match(loader, /临时报告正在生成，请稍候/);
  assert.match(loader, /临时报告已完成/);
  assert.match(loader, /adhocPollMs = 15_000/);
  assert.match(loader, /xuan-ib:adhoc-wait:v1/);
  assert.match(loader, /window\.addEventListener\("focus"/);
  assert.match(loader, /if \(adhocWait && !expireAdhocWait\(\)\) return loadLatest\(\)/);
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
  assert.match(app.status.textContent, /^临时报告已完成 · 报告 2026-08-28 · 临时版/);
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
  assert.match(app.status.textContent, /报告 2026-08-28 · 睡前版/);
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
  assert.match(app.status.textContent, /显示上一份已验证版本 · 报告 2026-08-27 · 睡前版/);
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
  assert.match(app.status.textContent, /报告 2026-08-27 · 早间版/);
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
  assert.match(promotion, /if ! node scripts\/handover-guard\.mjs/);
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
