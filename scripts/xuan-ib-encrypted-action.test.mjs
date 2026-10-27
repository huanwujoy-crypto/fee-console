// All keys, dates, report content and receipts below are synthetic, never live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {ACTION_SCHEMA, ACTION_DISPLAY_CSP, MAX_ACTION_HTML_BYTES, MAX_ACTION_ENVELOPE_BYTES,
  actionSha256, encryptPublishedAction, decryptPublishedAction, parseActionEnvelope, validateActionHtml} from './xuan-ib-encrypted-action.mjs';
import {packagePublishedAction, runActionPackage} from './xuan-ib-encrypted-action-build.mjs';
import {mountEncryptedAction, mountActionConverter, readActionEnvelope, actionFrameDocument, FEE_UNLOCK_STORAGE_KEY, ACTION_AUTO_UNLOCK_KEY} from './xuan-ib-encrypted-action-view.mjs';
import {renderNightActionReport, extractNightActionModel} from './xuan-ib-night-action-view.mjs';
const master = Buffer.alloc(32, 7).toString('base64url');
const other = Buffer.alloc(32, 8).toString('base64url');
const html = `<!doctype html><html lang="zh"><head><meta http-equiv="Content-Security-Policy" content="${ACTION_DISPLAY_CSP}"><title>Synthetic only</title></head><body><h1>合成参考报告</h1><p>示例金额 123.45，不是真实资料</p></body></html>`;
async function fixture(overrides = {}) {
  const payload = {schema: ACTION_SCHEMA, reportDate: '2026-01-02', publishedAt: '2026-01-02T06:00:00.000Z',
    sourceGeneration: '1001', displaySha256: await actionSha256(Buffer.from(html)), html, ...overrides};
  const receipt = {status: 'PRIVATE_PUBLICATION_FIXED_VERSION_VERIFIED', reportDateHkt: payload.reportDate,
    completedAtUtc: payload.publishedAt, target: {bucket: 'family-portfolio-gateway-xuan-preopen-private', object: 'delivery/owner-latest.html'},
    fixedReadback: {status: 'published-verified', code: 'PINNED_READBACK_VERIFIED', storageStatus: 'verified',
      generation: payload.sourceGeneration, sha256: payload.displaySha256, atUtc: payload.publishedAt}};
  return {payload, receipt, envelope: await encryptPublishedAction(payload, master)};
}
test('HKDF/AES-GCM roundtrip preserves original bytes and dates, encrypting all report metadata', async () => {
  const {payload, envelope} = await fixture();
  assert.deepEqual(await decryptPublishedAction(envelope, master), payload);
  assert.deepEqual(Object.keys(JSON.parse(envelope)), ['schema', 'kdf', 'salt', 'iv', 'ciphertext']);
  for (const secret of [master, payload.html, payload.reportDate, payload.publishedAt, payload.displaySha256, '123.45']) assert.ok(!envelope.includes(secret));
  const another = await encryptPublishedAction(payload, master);
  assert.notEqual(JSON.parse(another).salt, JSON.parse(envelope).salt);
  assert.notEqual(JSON.parse(another).iv, JSON.parse(envelope).iv);
});
test('wrong master, raw fee AES key, altered ciphertext/salt/IV and wrong protocol cannot decrypt', async () => {
  const {envelope} = await fixture();
  await assert.rejects(decryptPublishedAction(envelope, other));
  const e = JSON.parse(envelope), feeKey = await crypto.subtle.importKey('raw', Buffer.from(master, 'base64url'), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(crypto.subtle.decrypt({name: 'AES-GCM', iv: Buffer.from(e.iv, 'base64url'), additionalData: new TextEncoder().encode(ACTION_SCHEMA)}, feeKey, Buffer.from(e.ciphertext, 'base64url')));
  for (const name of ['ciphertext', 'salt', 'iv']) {
    const bad = structuredClone(e), b = Buffer.from(bad[name], 'base64url'); b[0] ^= 1; bad[name] = b.toString('base64url');
    await assert.rejects(decryptPublishedAction(JSON.stringify(bad), master));
  }
  for (const edit of [v => v.schema = 'other-purpose', v => v.kdf = 'PBKDF2', v => v.extra = 1]) {
    const bad = structuredClone(e); edit(bad); assert.throws(() => parseActionEnvelope(JSON.stringify(bad)));
  }
});
test('fee key standard/base64url encodings and padding represent the same master; links/passwords are refused', async () => {
  const {payload} = await fixture(), raw = Buffer.alloc(32, 255);
  const envelope = await encryptPublishedAction(payload, raw.toString('base64'));
  assert.deepEqual(await decryptPublishedAction(envelope, raw.toString('base64url')), payload);
  await assert.rejects(encryptPublishedAction(payload, 'password'));
  await assert.rejects(encryptPublishedAction(payload, 'https://example.invalid/#k=' + master));
});
test('bounded canonical envelope rejects duplicates, oversized bytes and noncanonical base64', async () => {
  const {envelope} = await fixture();
  assert.throws(() => parseActionEnvelope(envelope.replace('{', '{"kdf":"HKDF-SHA-256",')));
  assert.throws(() => parseActionEnvelope(' '.repeat(MAX_ACTION_ENVELOPE_BYTES + 1)));
  const e = JSON.parse(envelope); e.iv += '='; assert.throws(() => parseActionEnvelope(JSON.stringify(e)));
});
test('source pin/date/static HTML validation never turns active or mismatched input into a report', async () => {
  const {payload} = await fixture();
  for (const edit of [{displaySha256: '0'.repeat(64)}, {reportDate: '2026-02-30'}, {publishedAt: 'not-a-date'}, {sourceGeneration: 'latest'}]) {
    await assert.rejects(encryptPublishedAction({...payload, ...edit}, master));
  }
  for (const insert of ['<script>alert(1)</script>', '<iframe src="https://example.invalid"></iframe>', '<form></form>',
    '<img onerror="alert(1)">', '<a href="https://example.invalid">outbound</a>', '<meta http-equiv="refresh" content="0;url=https://example.invalid">', '<base href="https://example.invalid">']) {
    assert.throws(() => validateActionHtml(html.replace('</body>', insert + '</body>')));
  }
  assert.throws(() => validateActionHtml(html.replace('</body>', 'x'.repeat(MAX_ACTION_HTML_BYTES) + '</body>')));
  assert.throws(() => validateActionHtml(html.replace(ACTION_DISPLAY_CSP, "default-src *")));
});
test('conversion requires successful fixed-version receipt and retains original date, time and HTML', async () => {
  const {receipt, payload} = await fixture();
  const source = Buffer.from(html), before = Buffer.from(source);
  const text = await packagePublishedAction({htmlBytes: source, receipt, masterKey: master});
  assert.deepEqual(await decryptPublishedAction(text, master), payload); assert.deepEqual(source, before);
  for (const mutate of [r => r.fixedReadback.sha256 = 'f'.repeat(64), r => r.fixedReadback.status = 'unknown',
    r => r.fixedReadback.storageStatus = 'pending', r => r.fixedReadback.atUtc = '2026-01-03T06:00:00Z', r => r.target.object = 'other.html']) {
    const bad = structuredClone(receipt); mutate(bad);
    await assert.rejects(packagePublishedAction({htmlBytes: source, receipt: bad, masterKey: master}));
  }
});
test('packager writes only ciphertext once, rejects symlinks/public inputs/key arguments, no credential discovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-action-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const {receipt} = await fixture(), input = path.join(dir, 'input.html'), rp = path.join(dir, 'receipt.json'), out = path.join(dir, 'copy.json');
  fs.writeFileSync(input, html, {mode: 0o600}); fs.writeFileSync(rp, JSON.stringify(receipt), {mode: 0o600});
  const args = ['--input', input, '--receipt', rp, '--output', out];
  await assert.rejects(runActionPackage(args, {})); assert.ok(!fs.existsSync(out));
  await assert.rejects(runActionPackage([...args, '--key', master], {}));
  const result = await runActionPackage(args, {FEE_DATA_KEY: master}); assert.equal(result.status, 'encrypted-copy-prepared');
  assert.equal((await decryptPublishedAction(fs.readFileSync(out, 'utf8'), master)).html, html);
  const original = fs.readFileSync(out); await assert.rejects(runActionPackage(args, {FEE_DATA_KEY: master})); assert.deepEqual(fs.readFileSync(out), original);
  fs.chmodSync(input, 0o644); await assert.rejects(runActionPackage(args, {FEE_DATA_KEY: master}));
  fs.unlinkSync(input); fs.symlinkSync(rp, input); await assert.rejects(runActionPackage(args, {FEE_DATA_KEY: master}));
  const code = fs.readFileSync(new URL('./xuan-ib-encrypted-action-build.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /fetch\(|execFile|spawn\(|Keychain|SecretManager/);
});
test('fetch uses fixed relative ciphertext only, no credentials/redirects, bounded streaming', async () => {
  const {envelope} = await fixture(); let call;
  assert.equal(await readActionEnvelope(async (...args) => { call = args; return new Response(envelope); }, 'https://example.invalid/fee-console/xuan-ib/'), envelope);
  assert.equal(call[0].pathname, '/fee-console/xuan-ib/action.enc.json'); assert.equal(call[1].credentials, 'omit');
  assert.equal(call[1].redirect, 'error'); assert.equal(call[1].cache, 'no-store'); assert.ok(!String(call[0]).includes(master));
  await assert.rejects(readActionEnvelope(async () => new Response('', {status: 404}), 'https://example.invalid/'));
  await assert.rejects(readActionEnvelope(async () => new Response('x', {headers: {'content-length': MAX_ACTION_ENVELOPE_BYTES + 1}}), 'https://example.invalid/'));
  await assert.rejects(readActionEnvelope(async () => new Response(new Uint8Array(MAX_ACTION_ENVELOPE_BYTES + 1)), 'https://example.invalid/'));
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.checked = false; }
  append(n) { this.children.push(n); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k, v) { this.listeners[k] = v; }
  removeEventListener(k) { delete this.listeners[k]; }
  all() { return [this, ...this.children.flatMap(n => n.all())]; }
}
const until = async f => { for (let i = 0; i < 200; i++) { if (f()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('synthetic viewer did not settle'); };
function view(fetchImpl, initial = {}) {
  const values = new Map(Object.entries(initial)), reads = [], writes = [];
  const storage = {getItem(k) { reads.push(k); return values.get(k); }, setItem(k,v) { writes.push(k); values.set(k,v); }};
  const root = new Element('main'), win = new Element('window');
  const mounted = mountEncryptedAction(root, {document: {createElement: tag => new Element(tag)}, window: win, storage, fetchImpl, baseUrl: 'https://example.invalid/fee-console/xuan-ib/'});
  const frame = root.all().find(n => n.tagName === 'iframe'), status = root.all().find(n => n.attributes.role === 'status');
  const button = text => root.all().find(n => n.tagName === 'button' && n.textContent === text);
  return {root, win, values, reads, writes, frame, status, button, mounted};
}
test('saved fee key auto-unlocks with no extra key copy/token access; frame stays opaque and network-disabled', async () => {
  const {envelope} = await fixture(), f = view(async () => new Response(envelope), {[FEE_UNLOCK_STORAGE_KEY]: master});
  await until(() => !f.frame.hidden);
  assert.equal(f.frame.attributes.sandbox, ''); assert.equal(f.frame.attributes.referrerpolicy, 'no-referrer');
  assert.equal(f.frame.srcdoc, actionFrameDocument(html)); assert.match(f.status.textContent, /2026-01-02/);
  assert.ok(f.reads.every(k => [FEE_UNLOCK_STORAGE_KEY, ACTION_AUTO_UNLOCK_KEY].includes(k)));
  assert.ok(!f.writes.includes(FEE_UNLOCK_STORAGE_KEY));
  f.button('锁定行动版').listeners.click(); assert.equal(f.frame.srcdoc, ''); assert.equal(f.values.get(FEE_UNLOCK_STORAGE_KEY), master);
  assert.equal(f.values.get(ACTION_AUTO_UNLOCK_KEY), 'no'); f.mounted.dispose();
});
test('daily viewer collapses tools and preserves old dates; reopening fetches again', async () => {
  const {envelope} = await fixture({reportDate: '2000-01-02', publishedAt: '2000-01-02T06:00:00.000Z'});
  let reads = 0;
  const f = view(async () => { reads++; return new Response(envelope); }, {[FEE_UNLOCK_STORAGE_KEY]: master});
  await until(() => !f.frame.hidden);
  const settings = f.root.all().find(n => n.tagName === 'details');
  assert.equal(settings.hidden, false); assert.equal(settings.open, false);
  assert.ok(settings.all().includes(f.button('锁定行动版')));
  assert.ok(settings.all().includes(f.button('读取最新发布')));
  assert.equal(f.root.all().filter(n => n.tagName === 'a').length, 0);
  assert.equal(f.root.all().find(n => n.tagName === 'h1').hidden, true);
  assert.equal(f.status.textContent, '2000-01-02 · 历史参考 · 非实时');
  assert.match(f.status.title, /2000/);
  settings.open = true; f.win.listeners.pagehide();
  assert.equal(settings.open, false); assert.equal(f.frame.hidden, true);
  f.win.listeners.pageshow(); await until(() => !f.frame.hidden);
  assert.equal(reads, 2); assert.equal(settings.open, false); f.mounted.dispose();
});
test('no-key prompt remains; failed reload clears report and compact date without fallback', async () => {
  const missing = view(() => assert.fail('no-key page must not fetch'));
  assert.equal(missing.root.all().find(n => n.tagName === 'form').hidden, false);
  assert.equal(missing.root.all().find(n => n.tagName === 'details').hidden, true);
  assert.equal(missing.frame.hidden, true); missing.mounted.dispose();
  const {envelope} = await fixture(); let fail = false;
  const f = view(async () => { if (fail) throw new Error('offline'); return new Response(envelope); }, {[FEE_UNLOCK_STORAGE_KEY]: master});
  await until(() => !f.frame.hidden); fail = true; f.button('读取最新发布').listeners.click();
  await until(() => f.status.textContent.includes('读取失败'));
  assert.equal(f.frame.srcdoc, ''); assert.equal(f.frame.hidden, true);
  assert.equal(f.root.all().find(n => n.tagName === 'details').hidden, true);
  assert.equal(f.root.all().find(n => n.tagName === 'h1').hidden, false);
  assert.equal(f.status.title, ''); f.mounted.dispose();
});
test('numbered report disclosure retains every original date, limitation and value after source validation', async () => {
  const header = '<header class="book-report-header"><span id="report-state">账面更新完成 · 挂单待核实</span><h1>合成报告</h1><p>2000-01-02 · 读取 11:57–14:03 HKT · 估值 2000-01-01</p></header>';
  const paragraphs = ['仅作参考，完整范围未核实。', '原币未知；差额 -123.45；不参与集中度。'];
  const notes = '<aside class="notes" role="note"><p>'+paragraphs[0]+'</p></aside><aside class="notes reference-data"><p>'+paragraphs[1]+'</p></aside>';
  const card = '<section id="card-orders"><h2>挂单提醒</h2><p>买单 2 · 卖单本次返回未见</p><b>123.45</b></section>';
  const source = html.replace('<body>', '<body><main>').replace('</body>', header+notes+card+'</main></body>');
  const {payload} = await fixture({html: source, displaySha256: await actionSha256(Buffer.from(source))});
  await decryptPublishedAction(await encryptPublishedAction(payload, master), master);
  const rendered = actionFrameDocument(source);
  assert.ok(rendered.includes('<details class="action-report-notes"><summary>说明（来源与局限）</summary><ol>'));
  assert.doesNotMatch(rendered, /<details[^>]*\sopen/);
  for (const text of paragraphs) assert.equal(rendered.split(text).length, 2);
  assert.ok(rendered.includes(header.replace(' class="book-report-header"', '').replace(' · 挂单待核实', '')));
  assert.ok(rendered.includes(card)); // An unfamiliar card shape is not removed.
  assert.doesNotMatch(rendered, /挂单待核实|不是因为必须存在卖单/); validateActionHtml(rendered);
  assert.equal(await actionSha256(Buffer.from(source)), payload.displaySha256);
  const unfamiliar = source.replace(notes, notes.replace('</aside>', '<div>未知的新说明</div></aside>'));
  const unchanged = actionFrameDocument(unfamiliar);
  assert.ok(unchanged.includes(header)); assert.ok(unchanged.includes('未知的新说明'));
  assert.ok(!unchanged.includes('<details class="action-report-notes">'));
});
test('phone view removes the generated order reminder without changing model, budget or source evidence', async () => {
  for (const available of [true, false]) {
    const model = {schemaVersion: 1, dataDate: '2000-01-02', asOfHkt: '2000-01-02 13:05 HKT', status: 'partial',
      replenishment: {status: 'unavailable'}, cash: {status: 'unavailable'}, allocation: {status: 'unavailable'},
      orders: {status: available ? 'ready' : 'unavailable', asOfHkt: '2000-01-02 13:04 HKT',
        buys: available ? [{side: 'BUY', description: 'SYNTHETIC', limit: '1 USD', quantity: '2', status: 'NEW'}] : [], sells: []},
      notes: ['完整净预算未知；不代表零挂单或完整覆盖。', '挂单读取 2000-01-02 13:04 HKT；仅为快照。']};
    const source = renderNightActionReport(model).replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${ACTION_DISPLAY_CSP}">`);
    const {envelope, payload} = await fixture({html: source, displaySha256: await actionSha256(Buffer.from(source))});
    const decoded = await decryptPublishedAction(envelope, master), rendered = actionFrameDocument(decoded.html);
    const sourceBody = source.replace(/<!--[\s\S]*?-->/g, ''), renderedBody = rendered.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(sourceBody, /<h2>挂单提醒/); assert.doesNotMatch(renderedBody, /<h2>挂单提醒|class="order-group"/);
    assert.match(renderedBody, /部分更新/);
    for (const note of model.notes) assert.ok(renderedBody.includes(note));
    const cash = '<section class="card"><h2>现金优先补仓参考</h2>';
    assert.equal(rendered.slice(rendered.indexOf(cash)), source.slice(source.indexOf(cash)));
    assert.deepEqual(extractNightActionModel(rendered), model);
    assert.equal(await actionSha256(Buffer.from(decoded.html)), payload.displaySha256);
    validateActionHtml(rendered);
    // A missing end tag or changed following card must not erase other content.
    const malformed = source.replace('</section>\n'+cash, '\n'+cash);
    assert.match(actionFrameDocument(malformed).replace(/<!--[\s\S]*?-->/g, ''), /<h2>挂单提醒/);
    assert.match(actionFrameDocument(source.replace(cash, '<section class="card"><h2>新栏目</h2>')), /<h2>挂单提醒/);
  }
});
test('failed unlock never saves a typed key or falls back to public report; explicit remember waits for successful decrypt', async () => {
  const {envelope} = await fixture(), f = view(async () => new Response(envelope));
  const form = f.root.all().find(n => n.tagName === 'form'), input = f.root.all().find(n => n.type === 'password'), remember = f.root.all().find(n => n.type === 'checkbox');
  assert.equal(remember.checked, false); input.value = other; remember.checked = true;
  form.listeners.submit({preventDefault() {}}); await until(() => f.status.textContent.includes('读取失败'));
  assert.equal(f.frame.hidden, true); assert.equal(input.value, ''); assert.ok(!f.values.has(FEE_UNLOCK_STORAGE_KEY));
  input.value = master; form.listeners.submit({preventDefault() {}}); await until(() => !f.frame.hidden);
  assert.equal(f.values.get(FEE_UNLOCK_STORAGE_KEY), master); f.win.listeners.pagehide();
  assert.equal(f.frame.srcdoc, ''); assert.equal(input.value, ''); f.mounted.dispose();
});
test('late network completion cannot redisplay plaintext after pagehide/dispose', async () => {
  const {envelope} = await fixture(); let finish;
  const f = view(() => new Promise(resolve => finish = resolve), {[FEE_UNLOCK_STORAGE_KEY]: master});
  f.mounted.dispose(); finish(new Response(envelope)); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.frame.srcdoc, ''); assert.equal(f.root.children.length, 0);
});
test('refresh refuses older pinned generation and clears stale display instead of mislabelling it', async () => {
  const one = await fixture(), older = await fixture({sourceGeneration: '1000'}); let text = one.envelope;
  const f = view(async () => new Response(text), {[FEE_UNLOCK_STORAGE_KEY]: master});
  await until(() => !f.frame.hidden); text = older.envelope; f.button('读取最新发布').listeners.click();
  await until(() => f.status.textContent.includes('读取失败')); assert.equal(f.frame.hidden, true); f.mounted.dispose();
});
test('fixed URL selects encrypted module; explicit history still uses existing loader, build versions agree', () => {
  const shell = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
  const prefix = shell.slice(shell.indexOf('const encryptedRoot ='), shell.indexOf('const frame ='));
  let imported = false; const root = {getAttribute: () => 'v1', hidden: false}, old = {hidden: false};
  const run = query => vm.runInNewContext(`(function(){${prefix.replace(/import\("[^\"]+"\)/, 'loadModule()')} return 'history';})()`, {
    URL, location: {href: 'https://example.invalid/fee-console/xuan-ib/' + query},
    document: {querySelector: s => s === '#encrypted-action-root' ? root : old},
    loadModule: () => { imported = true; return Promise.resolve({mountEncryptedAction() {}}); }
  });
  assert.equal(run(''), undefined); assert.equal(imported, true); assert.equal(old.hidden, true);
  imported = false; assert.equal(run('?view=public'), 'history'); assert.equal(imported, false); assert.equal(root.hidden, true);
  const manifest = JSON.parse(fs.readFileSync(new URL('../xuan-ib/app-build.json', import.meta.url)));
  assert.ok(shell.includes(`const loaderBuild = "${manifest.build}"`));
  assert.ok(fs.readFileSync(new URL('../.github/workflows/scripts-check.yml', import.meta.url), 'utf8').includes('node --test scripts/xuan-ib-encrypted-action.test.mjs'));
});

function converter(initial = master) {
  const root = new Element('main'), win = new Element('window'), reads = [], downloads = [], revoked = [];
  const storage = {getItem(k) { reads.push(k); return initial; }, setItem() { assert.fail('conversion cannot persist credentials'); }};
  const urlApi = {createObjectURL(blob) { downloads.push(blob); return 'blob:synthetic-output'; }, revokeObjectURL(url) { revoked.push(url); }};
  const mounted = mountActionConverter(root, {document: {createElement: tag => new Element(tag)}, window: win, storage, urlApi});
  const files = root.all().filter(n => n.type === 'file'), button = root.all().find(n => n.tagName === 'button');
  return {root, win, reads, downloads, revoked, mounted, files, button,
    status: root.all().find(n => n.attributes.role === 'status'), download: root.all().find(n => n.download === 'action.enc.json')};
}
const fileOf = (text, onRead = () => {}) => ({size: Buffer.byteLength(text), async arrayBuffer() { onRead(); return new TextEncoder().encode(text).buffer; }});
test('browser converter waits for a trusted user click, uses only original local key, and downloads ciphertext after local verification', async () => {
  const {receipt} = await fixture(), f = converter(); let fileReads = 0;
  f.files[0].files = [fileOf(html, () => fileReads++)]; f.files[1].files = [fileOf(JSON.stringify(receipt), () => fileReads++)];
  assert.deepEqual(f.reads, []); assert.equal(fileReads, 0);
  await f.button.listeners.click({isTrusted: false}); assert.deepEqual(f.reads, []); assert.equal(fileReads, 0);
  await f.button.listeners.click({isTrusted: true});
  assert.equal(fileReads, 2); assert.deepEqual(f.reads, [FEE_UNLOCK_STORAGE_KEY]); assert.equal(f.download.hidden, false);
  assert.equal(f.downloads.length, 1); const envelope = await f.downloads[0].text();
  assert.equal((await decryptPublishedAction(envelope, master)).html, html); assert.ok(!envelope.includes(master));
  assert.match(f.status.textContent, /尚未发布/); assert.match(f.status.textContent, /2026-01-02/);
  assert.equal(f.files[0].value, ''); f.win.listeners.pagehide();
  assert.equal(f.download.hidden, true); assert.deepEqual(f.revoked, ['blob:synthetic-output']); f.mounted.dispose();
});
test('converter rejects missing/oversized/mismatched files and missing local key without output or credential writes', async () => {
  const {receipt} = await fixture();
  for (const kind of ['missing', 'oversize', 'mismatch', 'no-key']) {
    const f = converter(kind === 'no-key' ? null : master);
    f.files[0].files = [fileOf(html)]; f.files[1].files = [fileOf(JSON.stringify(receipt))];
    if (kind === 'missing') f.files[0].files = [];
    if (kind === 'oversize') f.files[0].files[0].size = MAX_ACTION_HTML_BYTES + 1;
    if (kind === 'mismatch') f.files[0].files = [fileOf(html.replace('123.45', '999.99'))];
    await f.button.listeners.click({isTrusted: true}); assert.equal(f.downloads.length, 0); assert.equal(f.download.hidden, true);
    if (kind === 'missing' || kind === 'oversize') assert.deepEqual(f.reads, []);
    if (kind === 'no-key') assert.match(f.status.textContent, /没有管理费解锁密钥/);
    f.mounted.dispose();
  }
});
test('converter double-click and pagehide during reading cannot start duplicate work or offer a late download', async () => {
  const {receipt} = await fixture(), f = converter(); let release;
  f.files[0].files = [{size: Buffer.byteLength(html), arrayBuffer: () => new Promise(resolve => release = resolve)}];
  f.files[1].files = [fileOf(JSON.stringify(receipt))];
  const pending = f.button.listeners.click({isTrusted: true}); await f.button.listeners.click({isTrusted: true});
  f.win.listeners.pagehide(); release(new TextEncoder().encode(html).buffer); await pending;
  assert.deepEqual(f.reads, []); assert.equal(f.downloads.length, 0); f.mounted.dispose();
});
test('conversion-only entry performs no auto-fetch or key lookup and future ciphertext stays specifically protected', () => {
  const root = new Element('main'), win = new Element('window'); let reads = 0;
  const app = mountEncryptedAction(root, {document: {createElement: tag => new Element(tag)}, window: win,
    storage: {getItem() { reads++; return master; }}, fetchImpl() { assert.fail('conversion entry must not fetch'); },
    baseUrl: 'https://example.invalid/fee-console/xuan-ib/?prepare=local'});
  assert.equal(reads, 0); assert.equal(root.all().filter(n => n.type === 'file').length, 2); app.dispose();
  const registry = JSON.parse(fs.readFileSync(new URL('../security/approval-tiers.json', import.meta.url)));
  assert.ok(registry.sensitiveFiles.includes('xuan-ib/action.enc.json'));
  assert.ok(!registry.ordinaryFiles.includes('xuan-ib/action.enc.json'));
});
