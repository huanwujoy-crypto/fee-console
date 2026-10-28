// All keys, dates, report content and receipts below are synthetic, never live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {ACTION_SCHEMA, ACTION_DISPLAY_CSP, MAX_ACTION_HTML_BYTES, MAX_ACTION_ENVELOPE_BYTES,
  actionSha256, encryptPublishedAction, decryptPublishedAction, parseActionEnvelope, validateActionHtml} from './xuan-ib-encrypted-action.mjs';
import {packagePublishedAction, runActionPackage} from './xuan-ib-encrypted-action-build.mjs';
import {mountEncryptedAction, mountActionConverter, readActionEnvelope, actionFrameDocument, FEE_UNLOCK_STORAGE_KEY, ACTION_AUTO_UNLOCK_KEY} from './xuan-ib-encrypted-action-view.mjs';
import ratioCrypto from 'node:crypto';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {buildRatioModel,stageRatioPacket,buildRatioBook,prepareRatioAttachment} from './fee-ratio-packet.mjs';
const master = Buffer.alloc(32, 7).toString('base64url');
const other = Buffer.alloc(32, 8).toString('base64url');

// Unified manager migration: synthetic sources/credentials only. These tests
// remain in the existing formal encrypted-viewer suite; no CI lane is added.
function ratioFixture(){
  const accounts=Array.from({length:10},(_,i)=>'Invented account '+i),scopeHash=ratioCrypto.createHash('sha256').update(JSON.stringify([...accounts].sort())).digest('hex');
  const exp={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scopeHash},core=createFeeRatioCore(exp,ratioCrypto.webcrypto);
  const exposure={schema:exp.RANKED_EXPOSURE_SCHEMA,retrievedAtBasis:exp.EXPOSURE_OBSERVED_TIME_BASIS,retrievedAt:'2000-01-03T02:00:00.000Z',summary:{asOf:'2000-01-03',currency:'USD',source:{provider:'Sharesight',view:'All Together',report:'Tools Exposure',groupBy:'No grouping',show:'Top 500',classification:'Investments→资产类别',url:'https://portfolio.sharesight.com/portfolios/1/tools/exposure/2?consolidated=true'},totalValueUSD:4000,accounts,classes:['PE/VC','对冲基金','常青基金','二级市场'].map((name,i)=>({name,...(i===0?{sourceCategory:'VC/PE'}:{}),totalValueUSD:1000,basis:i===3?'Exposure individual security direct plus ETF look-through, includes cash in class denominator':'direct',top5:Array.from({length:5},(_,j)=>({name:'Invented '+i+' security '+j,valueUSD:100-j*10,...(i===3?{securityCode:'SYNTH'+j,market:'TEST'}:{})}))})),residualETFs:{valueUSD:40,weightTotalPct:1,weightSecondaryClassPct:4},limitations:['Synthetic residual coverage'],transferStatus:'Synthetic source reconciliation incomplete',sourceXlsxSHA256:'e'.repeat(64)}};
  const model={schema:core.SCHEMA,source:'Sharesight',report:{kind:'snapshot',targetDate:'2000-01-03',feeAccountingThrough:'1999-12-31',generatedAt:'2000-01-03T03:00:00.000Z'},exposure,book:null,limitations:['Synthetic missing whole-book source']};
  return {core,exposure,model,scopeHash};
}
test('manager recipient needs original manager secret; investor fee key cannot decrypt ratio holdings',async()=>{
  const {core,model}=ratioFixture(),manager=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123'),cipher=await core.seal(model,manager.recipient);
  assert.equal(manager.privateKey.extractable,false);assert.deepEqual(await core.open(cipher,manager),model);
  for(const token of ['synthetic-investor-not-owner-456','synthetic-rotated-owner-token-789']){
    const wrong=await core.deriveManager('0'.repeat(32),master,token);await assert.rejects(core.open(cipher,wrong),/RATIO_MANAGER_REFUSED/);
  }
  const wrongGid=await core.deriveManager('1'.repeat(32),master,'synthetic-owner-token-for-ratio-123');await assert.rejects(core.open(cipher,wrongGid));
  const raw=JSON.stringify(cipher);for(const value of [master,'synthetic-owner-token-for-ratio-123','Invented account','Invented 0 security','4000','sourceXlsx'])assert.ok(!raw.includes(value));
  await assert.rejects(ratioCrypto.webcrypto.subtle.exportKey('pkcs8',manager.privateKey));
});
test('ratio ciphertext authenticates recipient, scope, header, nonce and content; no shared-key fallback',async()=>{
  const {core,model}=ratioFixture(),m=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123'),cipher=await core.seal(model,m.recipient);
  for(const edit of [x=>x.scopeId='a'.repeat(64),x=>x.recipientId='a'.repeat(64),x=>x.algorithm='shared-fee-key',x=>x.iv=core.encode(new Uint8Array(12)),x=>x.ciphertext=core.encode(new Uint8Array(32)),x=>x.extra=true,x=>x.salt=core.encode(new Uint8Array(32))]){
    const bad=structuredClone(cipher);edit(bad);await assert.rejects(core.open(bad,m),/RATIO_MANAGER_REFUSED/);
  }
  await assert.rejects(core.validateRecipient({...m.recipient,scopeId:'a'.repeat(64)}));
});
test('full module inventory is retained; missing CALL, orders, budget and holdings remain unknown',async()=>{
  const {core,model}=ratioFixture();await core.validateModel(model);const rendered=core.render(model);
  for(const title of ['本轮补仓','现金优先补仓参考','股票四类配置','All Together · 四类前五大持仓','完整持仓'])assert.ok(rendered.includes(title));
  assert.doesNotMatch(rendered,/挂单提醒|IB MCP|Flex快照|AvailableFunds|ETF产品前五/);assert.match(rendered,/金额未计算|预留及净预算保持未知/);assert.match(rendered,/本类资产|占总资产|占本类资产/);
  assert.match(rendered,/2.50%／10.00%/);assert.match(rendered,/Exposure 来源截至 2000-01-03/);assert.match(rendered,/管理费账务截至 1999-12-31，.*日期不同/);assert.match(rendered,/Synthetic residual coverage/);
  assert.equal((rendered.match(/<h3>/g)||[]).length,4);assert.equal((rendered.match(/Invented \d security \d/g)||[]).length,20);
});
test('ratio source, scope, classes and dates cannot be silently relabelled or widened',async()=>{
  const {core,model}=ratioFixture();
  for(const edit of [x=>x.source='broker',x=>x.exposure.summary.source.provider='broker',x=>x.exposure.summary.accounts[0]='foreign account',x=>x.exposure.summary.classes[3].basis='ETF products',x=>x.exposure.summary.asOf='2000-01-04',x=>x.book={source:'Flex'},x=>x.exposure.retrievedAtBasis='行情更新时间']){
    const bad=structuredClone(model);edit(bad);await assert.rejects(core.validateModel(bad));
  }
  const malicious=structuredClone(model);malicious.exposure.summary.classes[0].top5[0].name='<img src=x onerror=bad()> ';await core.validateModel(malicious);assert.doesNotMatch(core.render(malicious),/<img/);
});
test('revoked role or switched source disposes plaintext and blocks late decrypt completion',async()=>{
  const {core,model}=ratioFixture(),manager=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123'),cipher=await core.seal(model,manager.recipient);let allowed=false,who='a',shown='',derivations=0;
  const view=core.controller({authorized:()=>allowed,identity:()=>who,onRender:x=>shown=x,onClear:()=>shown=''}),derive=async()=>{derivations++;return manager;};
  assert.equal(await view.show(cipher,derive),false);assert.equal(derivations,0);assert.equal(shown,'');allowed=true;
  assert.equal(await view.show(cipher,derive),true);assert.ok(shown.includes('Invented'));view.clear();assert.equal(shown,'');assert.equal(view.hasPlaintext(),false);
  let release;const pending=view.show(cipher,()=>new Promise(r=>release=r));who='b';allowed=false;view.clear();release(manager);assert.equal(await pending,false);assert.equal(shown,'');
});
test('private ratio staging closes file ingress -> validated source -> recipient cipher, no secrets or fee writes',async t=>{
  const {core,model,exposure}=ratioFixture(),manager=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ratio-synthetic-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const spec=(name,o)=>{const p=path.join(root,name),b=Buffer.from(JSON.stringify(o));fs.writeFileSync(p,b,{mode:0o600});return {path:p,sha256:ratioCrypto.createHash('sha256').update(b).digest('hex')};};
  const plan={schema:'fee-console.ratio-stage-plan.v1',workspace:root,kind:'snapshot',targetDate:'2000-01-03',feeAccountingThrough:'1999-12-31',scopeId:manager.recipient.scopeId,input:spec('source.json',exposure),recipient:spec('recipient.json',manager.recipient)},original=fs.readFileSync(plan.input.path);
  const now=new Date(model.report.generatedAt),result=await stageRatioPacket({plan,environ:{},now,viewCore:core});assert.equal(result.publicationReady,false);assert.equal(result.keychainRead,false);assert.equal(result.feeOrIbWrite,false);
  const p=path.join(root,'ratio-candidate/ratio.envelope.json');assert.equal(fs.statSync(p).mode&0o777,0o600);const decoded=await core.open(JSON.parse(fs.readFileSync(p)),manager);assert.deepEqual(decoded.exposure,exposure);assert.equal(decoded.book,null);assert.deepEqual(fs.readFileSync(plan.input.path),original);
  await assert.rejects(stageRatioPacket({plan,environ:{},now,viewCore:core}));
  await assert.rejects(stageRatioPacket({plan,environ:{FEE_DATA_KEY:master},now,viewCore:core}));
  for(const edit of [x=>x.summary.asOf='2000-01-02',x=>x.retrievedAt='1999-12-31T00:00:00.000Z',x=>x.summary.source.provider='broker']){
    const bad=structuredClone(exposure);edit(bad);await assert.rejects(buildRatioModel(bad,{kind:'snapshot',targetDate:'2000-01-03',now,viewCore:core}));
  }
});
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
  assert.ok(rendered.includes(header.replace(' class="book-report-header"', '')));
  assert.ok(rendered.includes(card)); assert.match(rendered, /不是因为必须存在卖单/);
  assert.match(rendered, /不代表当前挂单/); validateActionHtml(rendered);
  assert.equal(await actionSha256(Buffer.from(source)), payload.displaySha256);
  const unfamiliar = source.replace(notes, notes.replace('</aside>', '<div>未知的新说明</div></aside>'));
  const unchanged = actionFrameDocument(unfamiliar);
  assert.ok(unchanged.includes(header)); assert.ok(unchanged.includes('未知的新说明'));
  assert.ok(!unchanged.includes('<details class="action-report-notes">'));
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
  const currentShell = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
  // Retirement must not delete the historical loader's crypto tests. Exercise
  // the unchanged archived loader while separately testing the inert new entry.
  let shell=currentShell;
  if(currentShell.includes('name="xuan-action-status" content="retired"')){
    shell='';for(const commit of execFileSync('git',['log','--format=%H','--','xuan-ib/index.html'],{encoding:'utf8'}).trim().split('\n')){
      const archived=execFileSync('git',['show',commit+':xuan-ib/index.html'],{encoding:'utf8'});
      if(archived.includes('const encryptedRoot =')&&archived.includes('const frame =')){shell=archived;break;}
    }
    assert.ok(shell,'the archived encrypted loader must remain available for verification');
  }
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

test('official ratio publication binds exact fee, source date, version and cipher and refuses rollback',async()=>{
  const {core,model}=ratioFixture(),m=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123');
  const fee={receiptId:'f'.repeat(64),asOf:'2000-01-03'},binding={schema:'fee-console.ratio-binding.v1',revision:ratioCrypto.randomUUID(),previousCipherSha256:null,feeReceiptId:fee.receiptId,feeAsOf:fee.asOf,sourceDate:'2000-01-03'};
  const same={...model,report:{...model.report,feeAccountingThrough:fee.asOf}},cipher=await core.seal(same,m.recipient,binding),pub=await core.publication(cipher,same),watermark=await core.validatePublication(cipher,pub,fee);
  assert.deepEqual(await core.open(cipher,m),same);await core.validatePublication(cipher,pub,fee,watermark);
  for(const edit of [x=>x.schema='old',x=>x.binding.sourceDate='2000-01-02',x=>x.binding.feeReceiptId='e'.repeat(64),x=>x.cipherSha256='a'.repeat(64),x=>x.recipientId='a'.repeat(64)]){const b=structuredClone(pub);edit(b);await assert.rejects(core.validatePublication(cipher,b,fee));}
  await assert.rejects(core.validatePublication(cipher,pub,{...fee,asOf:'2000-01-04'}));
  await assert.rejects(core.validatePublication(cipher,pub,fee,{...watermark,generatedAt:'2000-01-03T04:00:00.000Z'}));
  const replay=structuredClone(cipher);replay.binding.revision=ratioCrypto.randomUUID();await assert.rejects(core.open(replay,m));
  let html='';const ctl=core.controller({authorized:()=>true,identity:()=>1,onRender:s=>html=s,onClear:()=>html='',verify:()=>core.validatePublication(cipher,{...pub,schema:'old'},fee)});
  assert.equal(await ctl.show(cipher,async()=>m),false);assert.equal(html,'');
});

test('full Sharesight book cannot be replaced by Exposure rows, truncated pages or duplicate holdings',()=>{
  const performance={report:{portfolio_id:1,end_date:'2000-01-03',currency:{code:'USD'},grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},holdings:[{id:2,group_name:'美国底仓',value:100,instrument:{name:'Invented security',code:'SYNTH'}}],cash_accounts:[{id:3,value:5}]}},book={schema:'fee-console.ratio-sharesight-book.v1',source:'Sharesight',asOf:'2000-01-03',retrievedAt:'2000-01-03T02:00:00.000Z',sourceSha256:'a'.repeat(64),ib:{portfolio:{id:1,name:'IB-HK',currency:'USD'},performance},noah:null};
  const out=buildRatioBook(book,'2000-01-03');assert.equal(out.holdings.length,1);assert.equal(out.ibCashCents,500);assert.equal(out.noahCashCents,null);
  for(const edit of [x=>x.ib.performance.next_page=2,x=>x.ib.performance.report.holdings.push(x.ib.performance.report.holdings[0]),x=>delete x.ib.performance.report.cash_accounts,x=>x.ib.performance.report.currency.code='EUR',x=>x.ib.performance.report.end_date='2000-01-04']){const b=structuredClone(book);edit(b);assert.throws(()=>buildRatioBook(b,'2000-01-03'));}
});
const unifiedUiFile=process.env.FEE_RATIO_TEST_UI_PATH||new URL('../index.html',import.meta.url);
const unifiedUiSource=fs.readFileSync(unifiedUiFile,'utf8');
const independentRatioUi=unifiedUiSource.includes('const RATIO_SNAPSHOT_FILE=');
const legacyRatioFactorySha256='5e7570832f7655adca74c15d20c4540cc58f46f463506a847f23a8bb1aa7b8d1'; // exact already-published codec; support/UI roll out separately

test('unified UI embeds exact reviewed codec and denies investor, revoked roles and source switches',{skip:!unifiedUiSource.includes('const RATIO_RECIPIENT_FILE=')},async()=>{
  for(const [name,next]of [['xuan-ib-sharesight-exposure.mjs','const exposureCore='],['fee-ratio-management.mjs',null]]){
    let factory=fs.readFileSync(new URL('./'+name,import.meta.url),'utf8').split('export ',2)[1];if(next)factory=factory.slice(0,factory.indexOf('\n'+next));if(name==='fee-ratio-management.mjs'&&!independentRatioUi){const a=unifiedUiSource.indexOf('function createFeeRatioCore('),b=unifiedUiSource.indexOf('const ratioExposureCore=',a);assert.equal(ratioCrypto.createHash('sha256').update(unifiedUiSource.slice(a,b).trim()).digest('hex'),legacyRatioFactorySha256,'only the exact published legacy codec may coexist during support-first rollout');}else assert.ok(unifiedUiSource.includes(factory.trim()),name+' factory must match');
  }
  const {core,model}=ratioFixture(),manager=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123'),fee={receiptId:'f'.repeat(64),asOf:'2000-01-03'},m={...model,report:{...model.report,feeAccountingThrough:fee.asOf}},binding={schema:'fee-console.ratio-binding.v1',revision:ratioCrypto.randomUUID(),previousCipherSha256:null,feeReceiptId:fee.receiptId,feeAsOf:fee.asOf,sourceDate:fee.asOf},cipher=await core.seal(m,manager.recipient,binding),publication=await core.publication(cipher,m);
  const values=new Map([['gid','0'.repeat(32)],['key',master],['tok','synthetic-owner-token-for-ratio-123']]),elements=new Map(),timer=[];
  for(const id of ['ratioTab','p-ratio','ratioNotice','ratioContent','ratioCipherFile','p-investors']){const classes=new Set(id==='p-ratio'?['on']:[]);elements.set(id,{hidden:false,style:{},innerHTML:'',textContent:'',value:'',classList:{contains:s=>classes.has(s),add:s=>classes.add(s),remove:s=>classes.delete(s)},replaceChildren(){this.innerHTML='';}});}
  let allowed=true;
  const ctx={createRankedExposureCore:()=>({}),createFeeRatioCore:()=>core,managerDocumentsAuthorized:()=>allowed,sourceMatches:()=>true,_receiptSource:{state:'verified'},_readOnlyEntry:false,_sourceEpoch:1,_managerCapability:{state:'verified',ownerLogin:'synthetic-owner',ownerId:1,privateSource:true,verifiedAt:Date.now()},cfg:k=>values.get(k)||'',K:{gid:'gid',key:'key',tok:'tok'},store:{setItem:(k,v)=>values.set(k,v)},DAILY:{ratioManagerEnvelope:cipher,ratioManagerPublication:publication,feeCalculationReceipt:fee},document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[]},setTimeout:(fn,ms)=>{timer.push({fn,ms});return timer.length;},clearTimeout(){},Date,JSON,Error,Number,ghApi(){assert.fail('fresh existing capability must avoid metadata polling');}};
  const a=unifiedUiSource.indexOf('const ratioExposureCore='),b=unifiedUiSource.indexOf('async function registerRatioRecipient',a);vm.createContext(ctx);vm.runInContext(unifiedUiSource.slice(a,b)+'\nthis.runRatio=renderRatioManagement;',ctx);
  await ctx.runRatio();assert.match(elements.get('ratioContent').innerHTML,/Invented 0 security/);assert.equal(timer.at(-1).ms,600000);
  timer.at(-1).fn();assert.equal(elements.get('ratioContent').innerHTML,'');ctx._managerCapability.verifiedAt=0;const checks=[];ctx.ghApi=async route=>{checks.push(route);return route==='/user'?{id:1,login:'synthetic-owner'}:{public:false,owner:{id:1,login:'synthetic-owner'}};};await ctx.runRatio();assert.deepEqual(checks,['/user','/gists/'+'0'.repeat(32)]);allowed=false;await ctx.runRatio();assert.equal(elements.get('ratioContent').innerHTML,'');assert.equal(elements.get('ratioTab').hidden,true);
  allowed=true;ctx.DAILY.ratioManagerPublication={...publication,binding:{...publication.binding,feeReceiptId:'e'.repeat(64)}};elements.get('p-ratio').classList.add('on');await ctx.runRatio();assert.equal(elements.get('ratioContent').innerHTML,'');
  assert.ok(!unifiedUiSource.includes('cloud/ib-orders'));assert.match(unifiedUiSource,/pagehide/);
});

test('recipient registration requires a trusted preview and separate explicit purpose/fingerprint consent',{skip:!unifiedUiSource.includes('async function previewRatioRecipient(')},async()=>{
  const {core}=ratioFixture(),token='synthetic-owner-token-for-ratio-123';
  function harness(){
    let clock=Date.now(),derivations=0,revision='a'.repeat(40),raw=null,allow=true;
    const values=new Map([['gid','0'.repeat(32)],['key',master],['tok',token]]),elements=new Map(),calls=[],downloads=[];
    for(const id of ['ratioRecipientReview','ratioRecipientConsent','ratioRecipientConfirm','ratioRecipientFingerprint','ratioRecipientScope','ratioRecipientStatus','ratioContent','ratioCipherFile'])elements.set(id,{hidden:true,checked:false,disabled:true,textContent:'',value:'',replaceChildren(){this.textContent='';}});
    const ctx={createRankedExposureCore:()=>({}),createFeeRatioCore:()=>({...core,async deriveManager(...args){derivations++;return core.deriveManager(...args);}}),managerDocumentsAuthorized:()=>allow,_receiptSource:{state:'verified'},sourceMatches:()=>true,_readOnlyEntry:false,_sourceEpoch:1,_managerCapability:{state:'verified',privateSource:true,ownerId:1,ownerLogin:'synthetic-owner',verifiedAt:clock},cfg:k=>values.get(k)||'',K:{gid:'gid',key:'key',tok:'tok'},EDIT:{draft:null,pending:null},_ledgerBusy:false,_ratioSnapshotWrite:null,document:{getElementById:id=>elements.get(id)},Date:class extends Date{static now(){return clock;}},JSON,Number,Error,clearTimeout(){},saveBlob:(...args)=>downloads.push(args),async ghApi(route,opt={}){
      calls.push({route,method:opt.method||'GET'});assert.equal(route,'/gists/'+'0'.repeat(32));
      if(opt.method==='PATCH'){
        assert.equal(elements.get('ratioRecipientConsent').checked,true);assert.match(elements.get('ratioRecipientFingerprint').textContent,/^[a-f0-9]{64}$/);
        const body=JSON.parse(opt.body);assert.deepEqual(Object.keys(body.files),['fee-console-ratio-recipient.json']);raw=body.files['fee-console-ratio-recipient.json'].content;revision='b'.repeat(40);
      }
      return {public:false,owner:{id:1,login:'synthetic-owner'},history:[{version:revision}],files:raw?{'fee-console-ratio-recipient.json':{content:raw,truncated:false}}:{}};
    }};
    const a=unifiedUiSource.indexOf('const ratioExposureCore='),b=unifiedUiSource.indexOf('async function importRatioCipher',a);vm.createContext(ctx);vm.runInContext(unifiedUiSource.slice(a,b)+'\nthis.preview=previewRatioRecipient;this.confirm=registerRatioRecipient;this.clear=clearRatioManagement;',ctx);
    return {ctx,calls,downloads,elements,derivations:()=>derivations,advance:ms=>clock+=ms,role:value=>allow=value,changeRevision:()=>revision='c'.repeat(40)};
  }
  const h=harness();assert.equal(await h.ctx.preview({isTrusted:false}),false);assert.equal(await h.ctx.confirm({isTrusted:true}),false);assert.equal(h.derivations(),0);assert.equal(h.calls.length,0);
  assert.equal(await h.ctx.preview({isTrusted:true}),true);assert.equal(h.derivations(),1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].method,'GET');assert.equal(h.downloads.length,0);assert.equal(h.elements.get('ratioRecipientConsent').checked,false);assert.equal(h.elements.get('ratioRecipientReview').hidden,false);
  assert.equal(await h.ctx.confirm({isTrusted:true}),false);h.elements.get('ratioRecipientConsent').checked=true;assert.equal(await h.ctx.confirm({isTrusted:false}),false);assert.equal(h.calls.length,1);
  assert.equal(await h.ctx.confirm({isTrusted:true}),true);assert.equal(h.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(h.downloads.length,1);const downloaded=h.downloads[0][1];assert.ok(!downloaded.includes(master));assert.ok(!downloaded.includes(token));assert.equal(await h.ctx.confirm({isTrusted:true}),false);
  for(const mode of ['role','source','revision','expired','clear','fingerprint','scope','withdraw-consent']){
    const f=harness();assert.equal(await f.ctx.preview({isTrusted:true}),true);f.elements.get('ratioRecipientConsent').checked=true;
    if(mode==='role')f.role(false);if(mode==='source')f.ctx._sourceEpoch++;if(mode==='revision')f.changeRevision();if(mode==='expired')f.advance(300001);if(mode==='clear')f.ctx.clear();if(mode==='fingerprint')f.elements.get('ratioRecipientFingerprint').textContent='d'.repeat(64);if(mode==='scope')f.elements.get('ratioRecipientScope').textContent='d'.repeat(64);if(mode==='withdraw-consent')f.elements.get('ratioRecipientConsent').checked=false;
    assert.equal(await f.ctx.confirm({isTrusted:true}),false,mode);assert.equal(f.calls.some(c=>c.method==='PATCH'),false,mode);assert.equal(f.downloads.length,0);
  }
  const eventBlock=unifiedUiSource.slice(unifiedUiSource.indexOf('/* ============ 事件 ============ */'));
  assert.match(eventBlock,/T\.id==="ratioRecipient"\)\{previewRatioRecipient\(e\)/);assert.match(eventBlock,/T\.id==="ratioRecipientConfirm"\)\{registerRatioRecipient\(e\)/);
});

function syntheticBrowserBook(){
  const rows=[['SYNA','TEST','美国底仓',40,null],['USSC','TEST','美国底仓',10,2],['SYNT','TEST','美国科技',20,1],['SYND','TEST','非美发达',20,1],['SYNE','TEST','新兴市场',10,1],['VGSH','TEST','防御资产',5,1],['SYNR','TEST','主题投资',5,null]];
  return {schema:'fee-console.ratio-sharesight-browser-book.v1',source:'Sharesight',currency:'USD',asOf:'2000-01-03',retrievedAt:'2000-01-03T02:00:00.000Z',sourceSha256:'a'.repeat(64),provenance:{transport:'browser-export-and-ui',observedAtBasis:'original-export-download-time',exportCreatedAt:'2000-01-03T01:59:59.000Z',exportLastWrittenAt:'2000-01-03T02:00:00.123456Z',classificationSavedAt:'2000-01-03T02:01:00.654321Z',fullSourceBytes:10000,fullSourceSha256:'a'.repeat(64),transferStatus:'Synthetic Sharesight migration still incomplete',limitations:['Synthetic class residual remains -0.02 USD; do not flatten.','Synthetic converted cash is not the original currency amount.']},ib:{name:'IB-HK',holdings:rows.map((r,i)=>({code:r[0],market:r[1],group:r[2],valueUSD:r[3],quantity:r[4],name:null,valueBasis:i===0?'same-export-underlying-plus-residual':'preserved-browser-source'})),holdingsValueUSD:110,cashRows:[{label:'Synthetic base cash',valueUSD:3,valueBasis:'portfolio-usd-converted'},{label:'Synthetic other-currency cash',valueUSD:2,valueBasis:'portfolio-usd-converted'}],cashValueUSD:5,totalValueUSD:115},noah:{name:'NOAH-HK',cashValueUSD:7,valueBasis:'portfolio-usd-converted'}};
}
test('browser book preserves original dates, null quantities, converted cash and residual basis without API IDs',async()=>{
  const input=syntheticBrowserBook(),{core,exposure}=ratioFixture(),wrapped={schema:'fee-console.ratio-sources.v1',exposure,book:input},options={kind:'snapshot',targetDate:'2000-01-03',feeAccountingThrough:'2000-01-03',now:new Date('2000-01-03T03:00:00.000Z'),viewCore:core};
  const b=buildRatioBook(input,'2000-01-03');assert.equal(b.ibCashCents,500);assert.equal(b.noahCashCents,700);assert.equal(b.allocation.totalCents,10000);assert.equal(b.holdings[0].quantity,null);assert.equal(b.holdings[0].nameBasis,'source-code-only');assert.equal(b.browserEvidence.exportLastWrittenAt,input.provenance.exportLastWrittenAt);assert.equal(b.retrievedAt,input.retrievedAt);assert.equal(b.browserEvidence.integrity,'declared-not-verified-on-this-device');
  assert.doesNotMatch(JSON.stringify(b),/portfolio_id|holding_id|"id"/);
  const model=await buildRatioModel(wrapped,{...options,previewOnly:true}),html=core.render(model);assert.match(html,/原浏览器快照（非 API）|不能作为正式发布来源/);assert.match(html,/未知（原时点未取得）|底层＋残余合成/);assert.match(html,/IB-HK 完整持仓/);assert.match(html,/不代表 All Together 十账户/);
  await assert.rejects(buildRatioModel(wrapped,options)); // Preview is never official admission.
  const changed=structuredClone(wrapped);changed.book.asOf='2000-01-04';await assert.rejects(buildRatioModel(changed,{...options,previewOnly:true}));
  const forgery=structuredClone(model);forgery.book.browserEvidence.integrity='verified';await assert.rejects(core.validateModel(forgery));
});
test('browser source rejects fabricated API fields, mixed dates, relabelled currency, duplicates and false totals',()=>{
  for(const edit of [x=>x.portfolioId=1,x=>x.ib.holdings[0].id=1,x=>x.ib.holdings[0].quantity='unknown',x=>x.ib.holdings[0].quantity=-1,x=>x.ib.holdings.push(x.ib.holdings[0]),x=>x.ib.cashRows[1].label=x.ib.cashRows[0].label,x=>x.ib.cashRows[1].valueBasis='native-currency',x=>x.ib.totalValueUSD++,x=>x.provenance.fullSourceSha256='b'.repeat(64),x=>x.provenance.transport='API',x=>x.provenance.integrity='verified',x=>x.retrievedAt='2000-01-04T02:00:00.000Z']){const b=syntheticBrowserBook();edit(b);assert.throws(()=>buildRatioBook(b,'2000-01-03'));}
});

// Entirely invented original JSON/Library identity. Never import private files.
import {readVerifiedBrowserEvidence,consumeBrowserEvidence,verifyBrowserSourceAssociations} from './fee-ratio-browser-evidence.mjs';
import {attachRatioToPayload} from './fee-ratio-packet.mjs';
import {buildFeeCalculationReceipt,validateFeeCalculationReceipt} from './fee-receipt-core.mjs';
async function originalEvidenceFixture(t){
  const accounts=['IB-HK','NOAH-HK',...Array.from({length:8},(_,i)=>'Invented scope '+i)],scopeHash=ratioCrypto.createHash('sha256').update(JSON.stringify([...accounts].sort())).digest('hex');
  const exposureCore={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scopeHash},core=createFeeRatioCore(exposureCore,ratioCrypto.webcrypto),book=syntheticBrowserBook(),direct=[],positions=[],rows=[],names=['PE/VC','对冲基金','常青基金'];
  let sourceRow=1;
  const row=(securityCode,market,name,account,ownership,fourClass,valueUSD,withinETF=null)=>({securityCode,market,name,account,ownership,fourClass,valueUSD,withinETF,sourceRow:sourceRow++});
  for(let i=0;i<3;i++)for(let j=0;j<5;j++){
    const r={securityCode:'P'+i+'-'+j,market:'PRIVATE',name:'Invented full fund '+i+' '+j,account:accounts[i+2],sharesightCategory:names[i],fourClass:names[i],valueUSD:100-j*10,quantity:null,valuationCurrency:'USD',holdingId:null};direct.push({...r});positions.push({...r});rows.push(row(r.securityCode,r.market,r.name,r.account,'Direct',r.fourClass,r.valueUSD));
  }
  for(const h of book.ib.holdings){const r={securityCode:h.code,market:h.market,name:h.name||h.code,account:'IB-HK',sharesightCategory:h.group,fourClass:'二级市场',valueUSD:h.valueUSD,quantity:h.quantity,valuationCurrency:'USD',holdingId:null};direct.push({...r});positions.push({...r});if(h.valueBasis==='same-export-underlying-plus-residual'){rows.push(row('SYNUNDER','TEST','Invented constituent','IB-HK','Underlying','二级市场',38,h.code+'.'+h.market));rows.push(row(h.code,h.market,h.code,'IB-HK','Residual','二级市场',3));rows.push(row(h.code,h.market,h.code,'IB-HK','Residual','二级市场',-1));}else rows.push(row(r.securityCode,r.market,r.name,r.account,'Direct','二级市场',r.valueUSD));}
  const cash=[...book.ib.cashRows.map(r=>({name:r.label,account:'IB-HK',valueUSD:r.valueUSD,valuationCurrency:'USD',nativeBalance:null})),{name:'Invented cash aggregate',account:'NOAH-HK',valueUSD:book.noah.cashValueUSD,valuationCurrency:'USD',nativeBalance:null}];
  for(const c of cash)rows.push(row('USD',null,c.name,c.account,'Cash','二级市场',c.valueUSD));
  const aggregate=new Map();for(const r of rows)if(['Direct','Underlying'].includes(r.ownership)){const k=JSON.stringify([r.securityCode,r.market]);if(!aggregate.has(k))aggregate.set(k,{securityCode:r.securityCode,market:r.market,name:r.name,valueUSD:0});aggregate.get(k).valueUSD+=r.valueUSD;}
  const totalValueUSD=1322,classValues=[400,400,400,122],classNames=[...names,'二级市场'];
  const summary={asOf:book.asOf,currency:'USD',source:{provider:'Sharesight',view:'All Together',report:'Tools Exposure',groupBy:'No grouping',show:'Top 500',classification:'Investments→资产类别',url:'https://portfolio.sharesight.com/portfolios/1/tools/exposure/2?consolidated=true'},totalValueUSD,accounts,classes:classNames.map((name,i)=>({name,totalValueUSD:classValues[i],basis:i===3?'Exposure individual security direct plus ETF look-through, includes cash in class denominator':'direct',...(i===0?{sourceCategory:'VC/PE'}:{}),top5:i<3?direct.filter(r=>r.fourClass===name).sort((a,b)=>b.valueUSD-a.valueUSD).slice(0,5).map(r=>({name:r.securityCode,valueUSD:r.valueUSD})):rows.filter(r=>r.fourClass===name&&['Direct','Underlying'].includes(r.ownership)).sort((a,b)=>b.valueUSD-a.valueUSD).slice(0,5).map(r=>({name:r.name,valueUSD:r.valueUSD,securityCode:r.securityCode,market:r.market}))})),residualETFs:{valueUSD:2,weightTotalPct:2/totalValueUSD*100,weightSecondaryClassPct:2/122*100},limitations:['Invented Top500 scope is incomplete'],transferStatus:'Invented unreconciled migration',sourceXlsxSHA256:'e'.repeat(64)};
  const exposure={schema:exposureCore.RANKED_EXPOSURE_SCHEMA,retrievedAt:book.retrievedAt,retrievedAtBasis:exposureCore.EXPOSURE_OBSERVED_TIME_BASIS,summary};
  const raw={schemaVersion:'sharesight-private-full-v1',source:{provider:'Sharesight',apiResponse:false,view:'All Together',exposureURL:summary.source.url},snapshot:{asOf:book.asOf,currency:'USD',totalValueUSD,observedAt:book.retrievedAt,exportCreatedAt:book.provenance.exportCreatedAt,exportReceivedAtFilesystem:book.provenance.exportLastWrittenAt,classificationSnapshotSavedAt:book.provenance.classificationSavedAt},accounts,directHoldingsConsolidated:direct,directPositionsByAccount:positions,cashAccounts:cash,classTotals:classNames.map((name,i)=>({valueUSD:classValues[i],fourClass:name})),fourClassTotals:classNames.map((name,i)=>({name,valueUSD:classValues[i]})),coverage:{originalDirectPositionTableCompleteForObservedOpenScope:true,allExportRowsIncluded:true,closedPositionsIncluded:false,transactionHistoryIncluded:false,completeETFUniverseClaimed:false,directConsolidatedSecurities:direct.length,directAccountPositions:positions.length,cashAccounts:cash.length,exposureExportRows:rows.length,exposureSecurityAggregateCount:aggregate.size,exposureDirectRows:rows.filter(r=>r.ownership==='Direct').length,exposureUnderlyingRows:1,exposureResidualRows:2,exposureCashRows:cash.length,directPlusCashRowsValueUSD:totalValueUSD,directPlusCashRoundingDeltaVersusReportedTotalUSD:0},exposure:{rows,securitiesAggregatedFromExport:[...aggregate.values()],uiKnownAggregateDifferences:[],residualValueUSD:2,residualWeightTotalPct:summary.residualETFs.weightTotalPct,residualWeightSecondaryPct:summary.residualETFs.weightSecondaryClassPct,exportRowsTotalUSD:totalValueUSD,roundingDeltaVersusOriginalPortfolioUSD:0},readOnlySupplement:{mustNotSilentlyMergeIntoOriginalSnapshot:true,newAsOf:'2000-01-04',newQuantity:999,nativeCash:999},transferReconciliation:{receiptConfirmed:false,status:'unreconciled'},sourceFileSHA256:{'Invented_Exposure.xlsx':'e'.repeat(64)}};
  const rawBytes=Buffer.from(JSON.stringify(raw)),hash=b=>ratioCrypto.createHash('sha256').update(b).digest('hex');book.sourceSha256=hash(rawBytes);book.provenance.fullSourceSha256=hash(rawBytes);book.provenance.fullSourceBytes=rawBytes.length;
  const input={schema:'fee-console.ratio-sources.v1',exposure,book},dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ratio-proof-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=(name,obj)=>{const b=Buffer.isBuffer(obj)?obj:Buffer.from(JSON.stringify(obj)),file=path.join(dir,name);fs.writeFileSync(file,b,{mode:0o600});return {path:file,sha256:hash(b)};};
  const manager=await core.deriveManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123'),plan={schema:'fee-console.ratio-browser-evidence-plan.v1',workspace:dir,source:write('original.json',rawBytes),input:write('input.json',input),library:{libraryFileId:'libfile_'+'1'.repeat(32),version:0},managerScopeId:manager.recipient.scopeId,localOwnerUid:process.getuid()},planPath=write('plan.json',plan).path;
  const identity={libraryFileId:plan.library.libraryFileId,version:'0'},runtime={uid:process.getuid(),readIdentity:()=>({...identity})},now=new Date('2000-01-03T03:00:00.000Z');
  return {raw,input,core,exposureCore,manager,plan,planPath,write,identity,runtime,now,read(extra={}){return readVerifiedBrowserEvidence({planPath,expectedScopeId:manager.recipient.scopeId,input,now,runtime,exposureCore,...extra});},save(){write('plan.json',plan);}};
}
test('official model and sole-writer addition consume complete source proof, without changing fees or conferring flow authority',async t=>{
  const f=await originalEvidenceFixture(t),proof=f.read(),model=await buildRatioModel(f.input,{kind:'snapshot',targetDate:'2000-01-03',browserEvidence:proof,managerScopeId:f.plan.managerScopeId,viewCore:f.core,now:f.now});
  assert.equal(model.book.browserEvidence.integrity,'verified-original-library-association');assert.match(f.core.render(model),/不含闭仓／交易历史|不证明未来IB流量/);assert.equal(model.book.holdings[0].quantity,null);assert.equal(model.book.browserEvidence.migrationPending,true);
  const econ={v:4,settings:{start:'2000-01-03',mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},data={daily:[{d:'2000-01-03',schwab:60,webull:40,spy:100,qqq:100,bd:'2000-01-03',bstate:'session'}],flowsAuto:[],flowsUnresolved:[],status:{asOf:'2000-01-03',provisional:false,calibrated:true,unresolvedCount:0},ibExisting:{synthetic:'unchanged'}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput:econ});
  const after=await attachRatioToPayload(data,f.input,f.manager.recipient,{kind:'snapshot',sourceDate:'2000-01-03',scopeId:f.plan.managerScopeId,viewCore:f.core,browserEvidence:proof,now:f.now});
  assert.equal(validateFeeCalculationReceipt(after.feeCalculationReceipt,after).ok,true);const {ratioManagerEnvelope,ratioManagerPublication,...rest}=after;assert.deepEqual(rest,data);assert.equal((await f.core.open(ratioManagerEnvelope,f.manager)).book.browserEvidence.integrity,'verified-original-library-association');
  assert.throws(()=>consumeBrowserEvidence(JSON.parse(JSON.stringify(proof)),f.input,f.plan.managerScopeId,f.now));assert.throws(()=>consumeBrowserEvidence(proof,f.input,'f'.repeat(64),f.now));assert.throws(()=>consumeBrowserEvidence(proof,f.input,f.plan.managerScopeId,new Date('2000-01-05T03:00:00.000Z')));
  await assert.rejects(f.core.seal(model,(await f.core.deriveManager('2'.repeat(32),master,'synthetic-other-manager-token-456')).recipient));
});
for(const mode of ['wrong-hash','tampered-file','summary-only','wrong-library','wrong-version','cross-user','cross-scope','mixed-asof','mixed-time','supplement-quantity','supplement-cash','expired','cash-currency','incomplete-rows','fake-proof','wrong-source-version','cross-account-row','duplicate-source-row','consolidated-mismatch'])test('original browser evidence refuses '+mode,async t=>{
  const f=await originalEvidenceFixture(t);let extra={};
  if(mode==='wrong-hash')f.plan.source.sha256='a'.repeat(64);
  if(mode==='tampered-file')fs.appendFileSync(f.plan.source.path,' ');
  if(mode==='summary-only'){f.plan.source=f.write('original.json',{summary:f.raw.snapshot});f.input.book.sourceSha256=f.plan.source.sha256;f.input.book.provenance.fullSourceSha256=f.plan.source.sha256;f.input.book.provenance.fullSourceBytes=fs.statSync(f.plan.source.path).size;f.plan.input=f.write('input.json',f.input);}
  if(mode==='wrong-library')f.identity.libraryFileId='libfile_'+'2'.repeat(32);
  if(mode==='wrong-version')f.identity.version='1';
  if(mode==='cross-user')f.runtime.uid++;
  if(mode==='cross-scope')extra.expectedScopeId='f'.repeat(64);
  if(mode==='mixed-asof')f.input.book.asOf='2000-01-04';
  if(mode==='mixed-time')f.input.book.retrievedAt='2000-01-04T02:00:00.000Z';
  if(mode==='supplement-quantity')f.input.book.ib.holdings[0].quantity=f.raw.readOnlySupplement.newQuantity;
  if(mode==='supplement-cash')f.input.book.ib.cashRows[0].valueUSD=f.raw.readOnlySupplement.nativeCash;
  if(mode==='expired')extra.now=new Date('2000-01-05T03:00:00.000Z');
  if(mode==='cash-currency')f.raw.cashAccounts[0].valuationCurrency='CAD';
  if(mode==='incomplete-rows')f.raw.exposure.rows.pop();
  if(mode==='fake-proof')f.plan.approved=true;
  if(mode==='wrong-source-version')f.raw.schemaVersion='sharesight-private-full-v0';
  if(mode==='cross-account-row')f.raw.exposure.rows[0].account='Invented outside scope';
  if(mode==='duplicate-source-row')f.raw.exposure.rows[1].sourceRow=f.raw.exposure.rows[0].sourceRow;
  if(mode==='consolidated-mismatch')f.raw.directHoldingsConsolidated[0].valueUSD++;
  if(['mixed-asof','mixed-time','supplement-quantity','supplement-cash'].includes(mode))f.plan.input=f.write('input.json',f.input);
  if(['cash-currency','incomplete-rows','wrong-source-version','cross-account-row','duplicate-source-row','consolidated-mismatch'].includes(mode)){f.plan.source=f.write('original.json',f.raw);f.input.book.sourceSha256=f.plan.source.sha256;f.input.book.provenance.fullSourceSha256=f.plan.source.sha256;f.input.book.provenance.fullSourceBytes=fs.statSync(f.plan.source.path).size;f.plan.input=f.write('input.json',f.input);}
  f.save();assert.throws(()=>f.read(extra),/RATIO_BROWSER_EVIDENCE_REFUSED/);
});
test('proof fails use-time replay after raw/input/identity change and never reads future supplement as source',async t=>{
  const f=await originalEvidenceFixture(t),proof=f.read();consumeBrowserEvidence(proof,f.input,f.plan.managerScopeId,f.now);f.identity.version='1';assert.throws(()=>consumeBrowserEvidence(proof,f.input,f.plan.managerScopeId,f.now));f.identity.version='0';fs.appendFileSync(f.plan.source.path,' ');assert.throws(()=>proof.check());
});

test('actual sole-writer ratio entry revalidates source evidence and binds encrypted synthetic output',async t=>{
  const f=await originalEvidenceFixture(t),day='2000-01-03',econ={v:4,settings:{start:day,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},data={daily:[{d:day,schwab:60,webull:40,spy:100,qqq:100,bd:day,bstate:'session'}],flowsAuto:[],flowsUnresolved:[],status:{asOf:day,provisional:false,calibrated:true,unresolvedCount:0},oldIbState:{synthetic:'preserve'}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput:econ});
  const key=Buffer.from(master,'base64url'),iv=ratioCrypto.randomBytes(12),cipher=ratioCrypto.createCipheriv('aes-256-gcm',key,iv),sealed=Buffer.concat([iv,cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]);
  const base=f.write('base.json',{enc:true,v:3,data:sealed.toString('base64')}),recipient=f.write('recipient.json',f.manager.recipient),outDir=path.join(f.plan.workspace,'out');fs.mkdirSync(outDir,{mode:0o700});
  const args={file:base.path,inputFile:f.plan.input.path,recipientFile:recipient.path,outputFile:path.join(outDir,'data.json'),kind:'snapshot',sourceDate:day,scopeId:f.plan.managerScopeId,keyText:master,execute:true,environ:{},now:f.now,viewCore:f.core,evidenceContext:{runtime:f.runtime,exposureCore:f.exposureCore}};
  await assert.rejects(prepareRatioAttachment(args));assert.equal(fs.existsSync(args.outputFile),false);
  assert.equal((await prepareRatioAttachment({...args,browserEvidenceFile:f.planPath})).status,'RATIO_ATTACHMENT_ENCRYPTED_CANDIDATE_PREPARED');assert.equal(fs.statSync(args.outputFile).mode&0o777,0o600);
  const packed=Buffer.from(JSON.parse(fs.readFileSync(args.outputFile)).data,'base64'),dec=ratioCrypto.createDecipheriv('aes-256-gcm',key,packed.subarray(0,12));dec.setAuthTag(packed.subarray(-16));const after=JSON.parse(Buffer.concat([dec.update(packed.subarray(12,-16)),dec.final()])),{ratioManagerEnvelope,ratioManagerPublication,...rest}=after;assert.deepEqual(rest,data);const model=await f.core.open(ratioManagerEnvelope,f.manager);assert.equal(model.book.browserEvidence.managerScopeId,f.plan.managerScopeId);assert.equal(model.book.browserEvidence.integrity,'verified-original-library-association');
});

import {validateIbBootstrapCoverage} from './ib-manager-source.mjs';
test('open-position browser proof is never accepted as IB flow or transfer coverage',async t=>{const f=await originalEvidenceFixture(t),proof=f.read();assert.throws(()=>validateIbBootstrapCoverage(JSON.parse(JSON.stringify(proof)),'a'.repeat(64)));});

import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {stageIndependentRatioSnapshot} from './fee-ratio-snapshot-packet.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
async function independentFixture(t){
  const f=await originalEvidenceFixture(t),manager=await f.core.deriveSnapshotManager('0'.repeat(32),master,'synthetic-owner-token-for-ratio-123');
  const snapshot=createRatioSnapshotCore(f.core,f.exposureCore,createRatioSourceCore,s=>createLegacyPolicy().parseExactJson(s),ratioCrypto.webcrypto);
  const model=await buildRatioModel(f.input,{kind:'snapshot',targetDate:f.input.book.asOf,browserEvidence:f.read(),managerScopeId:manager.recipient.scopeId,viewCore:f.core,now:f.now});
  const args={originalBytes:new Uint8Array(fs.readFileSync(f.plan.source.path)),inputBytes:new Uint8Array(fs.readFileSync(f.plan.input.path)),model,recipient:manager.recipient,sourceSha256:f.plan.source.sha256,inputSha256:f.plan.input.sha256,libraryVersion:0,now:f.now};
  const proof=await snapshot.verifyOriginal(args),packet=await snapshot.candidate({model,recipient:manager.recipient,proof,now:f.now}),options={profileSha256:'a'.repeat(64),now:f.now};
  return {...f,manager,snapshot,model,args,proof,packet,options};
}
test('independent snapshot complete original to authenticated cipher to manager display leaves fee data untouched',async t=>{
  const f=await independentFixture(t),before={fee:123,health:{checkedAt:'2000-01-01'},ibReturn:-1},saved=JSON.stringify(before);
  assert.equal(f.manager.authenticationKey.extractable,false);assert.equal(f.manager.privateKey.extractable,false);
  const published=await f.snapshot.authenticate(f.packet,f.proof,f.manager,f.options),out=await f.snapshot.verify(published,f.manager,{now:f.now});
  assert.deepEqual(out.model,f.model);assert.equal(out.stale,false);assert.equal(out.model.report.feeAccountingThrough,null);assert.equal(published.body.envelope.binding.feeReceiptId,null);assert.equal(JSON.stringify(before),saved);
  const future=new Date('2000-01-10T03:00:00.000Z');assert.equal((await f.snapshot.verify(published,f.manager,{now:future})).stale,true);
  const html=f.core.render(out.model);assert.match(html,/四类资产配置总览/);assert.match(html,/二级市场为前三类以外全部资产，含现金/);assert.match(html,/舍入差/);assert.equal((html.match(/role="meter"/g)||[]).length,4);
});
test('independent snapshot refuses byte/hash/time/scope/currency/summary and mixed supplement forgeries',async t=>{
  const f=await independentFixture(t);
  for(const mutate of [a=>a.sourceSha256='0'.repeat(64),a=>a.inputSha256='0'.repeat(64),a=>a.originalBytes=new TextEncoder().encode('{}'),a=>a.libraryVersion=-1,a=>a.now=new Date('2000-01-05'),a=>a.model.report.targetDate='2000-01-04',a=>a.model.report.feeAccountingThrough='2000-01-03',a=>a.model.book.ibCashCents++,a=>a.model.exposure.summary.classes[0].totalValueUSD+=10,a=>a.model.book.holdings[0].quantity=999,a=>a.model.book.browserEvidence.managerScopeId='f'.repeat(64),a=>a.model.book.browserEvidence.migrationPending=false,a=>a.model.book.browserEvidence.classificationDeltaCents++,a=>a.model.book.browserEvidence.integrity='declared-not-verified-on-this-device']){
    const a=structuredClone(f.args);mutate(a);await assert.rejects(f.snapshot.verifyOriginal(a));
  }
  for(const mutate of [x=>x.book.currency='EUR',x=>x.book.asOf='2000-01-04',x=>x.book.ib.holdings[0].quantity=999,x=>x.exposure.summary.accounts[0]='Different user',x=>x.book.provenance.fullSourceBytes++,x=>x.book.retrievedAt='2000-01-04T02:00:00.000Z']){
    const input=structuredClone(f.input);mutate(input);const b=new TextEncoder().encode(JSON.stringify(input));await assert.rejects(f.snapshot.verifyOriginal({...f.args,inputBytes:b,inputSha256:await f.snapshot.digestBytes(b)}));
  }
  await assert.rejects(f.snapshot.candidate({model:f.model,recipient:f.manager.recipient,proof:JSON.parse(JSON.stringify(f.proof)),now:f.now}));
});
test('independent authentication refuses forged MAC, public-key-only sender, changed model/health and another manager',async t=>{
  const f=await independentFixture(t),p=await f.snapshot.authenticate(f.packet,f.proof,f.manager,f.options);
  for(const mutate of [x=>x.authentication=null,x=>x.authentication.mac='A'.repeat(43),x=>x.body.source.asOf='2000-01-04',x=>x.body.source.capturedAt='2000-01-03T02:30:00.000Z',x=>x.body.source.modelSha256='f'.repeat(64),x=>x.body.envelope.ciphertext=x.body.envelope.ciphertext.slice(1),x=>x.body.version++,x=>x.authentication.confirmedAt='2000-01-10T00:00:00.000Z',x=>x.authentication.profileSha256='f'.repeat(64),x=>x.body.source.provider='IBKR']){
    const b=structuredClone(p);mutate(b);await assert.rejects(f.snapshot.verify(b,f.manager,{now:f.now}));
  }
  const otherManager=await f.core.deriveSnapshotManager('1'.repeat(32),master,'synthetic-owner-token-for-ratio-123');await assert.rejects(f.snapshot.verify(p,otherManager,{now:f.now}));
  await assert.rejects(f.snapshot.authenticate(f.packet,f.proof,{...f.manager,authenticationKey:null},f.options));
  await assert.rejects(f.snapshot.authenticate(f.packet,f.proof,f.manager,{...f.options,now:new Date('2000-01-05')}));
});
test('independent version chain and recipient scoped watermark reject replay and cross-version substitution',async t=>{
  const f=await independentFixture(t),first=await f.snapshot.authenticate(f.packet,f.proof,f.manager,f.options);
  const secondCandidate=await f.snapshot.candidate({model:f.model,recipient:f.manager.recipient,proof:f.proof,previous:first,now:f.now}),second=await f.snapshot.authenticate(secondCandidate,f.proof,f.manager,{...f.options,previous:first}),wm=(await f.snapshot.verify(second,f.manager,{now:f.now})).watermark;
  assert.equal(second.body.version,2);assert.equal(second.body.previousSnapshotId,await f.core.digest(first.body));
  await assert.rejects(f.snapshot.verify(first,f.manager,{watermark:wm,now:f.now}));await f.snapshot.verify(second,f.manager,{watermark:wm,now:f.now});
  await assert.rejects(f.snapshot.authenticate(secondCandidate,f.proof,f.manager,f.options));
  const bad=structuredClone(secondCandidate);bad.body.envelope.binding.previousCipherSha256='f'.repeat(64);await assert.rejects(f.snapshot.authenticate(bad,f.proof,f.manager,{...f.options,previous:first}));
  const fabricated=structuredClone(first);fabricated.authentication.mac='A'.repeat(43);await assert.rejects(f.snapshot.authenticate(secondCandidate,f.proof,f.manager,{...f.options,previous:fabricated}));
});
test('independent private CLI is public-recipient-only, original identity checked and emits candidate-only 0600 files',async t=>{
  const f=await independentFixture(t),workspace=path.dirname(f.planPath),recipient=f.write('public-recipient.json',f.manager.recipient),evidence=f.write('evidence-plan.json',f.plan),plan={schema:'fee-console.ratio-snapshot-plan.v1',workspace,evidence,recipient,previous:null};
  const result=await stageIndependentRatioSnapshot({plan,now:f.now,environ:{},evidenceRuntime:f.runtime,exposureCore:f.exposureCore});assert.equal(result.publicationReady,false);assert.equal(result.keychainRead,false);assert.equal(result.feeOrHealthWrite,false);
  const out=path.join(workspace,'ratio-independent-candidate');assert.equal(fs.statSync(out).mode&0o777,0o700);for(const name of fs.readdirSync(out))assert.equal(fs.statSync(path.join(out,name)).mode&0o777,0o600);
  const packet=JSON.parse(fs.readFileSync(path.join(out,'fee-console-ratio-snapshot.candidate.json')));assert.equal(packet.authentication,null);assert.deepEqual(await f.core.open(packet.body.envelope,f.manager),f.model);
  await assert.rejects(stageIndependentRatioSnapshot({plan,now:f.now,environ:{},evidenceRuntime:f.runtime,exposureCore:f.exposureCore}));
  for(const env of [{FEE_DATA_KEY:'synthetic'},{GH_TOKEN:'synthetic'},{NODE_OPTIONS:'--inspect'},{DYLD_INSERT_LIBRARIES:'invented'}])await assert.rejects(stageIndependentRatioSnapshot({plan,now:f.now,environ:env,evidenceRuntime:f.runtime,exposureCore:f.exposureCore}));
});

test('independent browser closed loop requires trusted two-phase consent and touches only the private snapshot file',{skip:!independentRatioUi},async t=>{
  const f=await independentFixture(t),code=unifiedUiSource.slice(unifiedUiSource.indexOf('const ratioSnapshotParse='),unifiedUiSource.indexOf('/* fee-ratio-management:manager-v1:end */'));
  assert.ok(code.startsWith('const ratioSnapshotParse='));
  function harness(){
    let allowed=true,clock=f.now.getTime(),failure='',readFailure=false;const calls=[],elements=new Map(),values=new Map();
    for(const id of ['p-ratio','ratioNotice','ratioContent','ratioSnapshotReview','ratioSnapshotConsent','ratioSnapshotConfirm','ratioSnapshotSummary','ratioSnapshotStatus','ratioSnapshotCandidate','ratioSnapshotOriginal','ratioSnapshotInput'])elements.set(id,{hidden:false,disabled:false,checked:false,textContent:'',innerHTML:'',value:'',classList:{contains:()=>true},replaceChildren(){this.innerHTML='';}});
    const gid='0'.repeat(32),token='synthetic-owner-token-for-ratio-123',gist={public:false,owner:{id:1,login:'synthetic'},history:[{version:'a'.repeat(40)}],files:{'fee-console-ratio-recipient.json':{content:JSON.stringify(f.manager.recipient)},'original-ledger.json':{content:'DO_NOT_CHANGE'}}};
    const original=JSON.stringify(gist.files['original-ledger.json']);
    const build=()=>{const s=f.snapshot;return {...s,verifyOriginal:o=>s.verifyOriginal({...o,now:new Date(clock)}),authenticate:(p,proof,m,o)=>s.authenticate(p,proof,m,{...o,now:new Date(clock)}),verify:(p,m,o)=>s.verify(p,m,{...o,now:new Date(clock)})};};
    const ctx={createRatioSnapshotCore:build,createRatioSourceCore,createFeeRatioCore,createRankedExposureCore,createLegacyPolicy,ratioCore:f.core,ratioExposureCore:f.exposureCore,Uint8Array,TextEncoder,Date:class extends Date{constructor(v){super(v===undefined?clock:v);}static now(){return clock;}},JSON,Number,Error,Promise,Object,EDIT:{},_ledgerBusy:false,_ratioSnapshotWrite:null,_ratioRecipientWrite:null,_sourceEpoch:1,_ratioTicket:0,_ratioExpiry:null,_ratioPreview:null,RATIO_SESSION_MS:600000,RATIO_RECIPIENT_FILE:'fee-console-ratio-recipient.json',_managerCapability:{ownerId:1,ownerLogin:'synthetic'},ratioAuthorized:()=>allowed,ratioIdentity:()=>JSON.stringify([gid,allowed]),cfg:k=>({gid,key:master,tok:token}[k]||values.get(k)||''),K:{gid:'gid',key:'key',tok:'tok'},store:{setItem:(k,v)=>values.set(k,v)},document:{getElementById:id=>elements.get(id)},setTimeout:()=>1,clearTimeout(){},verifyRatioCapabilityNow:async()=>allowed,clearRatioManagement(){elements.get('ratioContent').replaceChildren();ctx.ops?.clear(true);},renderRatioManagement:async()=>true,ghApi:async(route,opt={})=>{calls.push({route,method:opt.method||'GET'});if(route!=='/gists/'+gid)assert.fail('fixed same-Gist endpoint only');if(opt.method==='PATCH'){assert.equal(allowed,true);const body=JSON.parse(opt.body);assert.deepEqual(Object.keys(body),['files']);assert.deepEqual(Object.keys(body.files),['fee-console-ratio-snapshot.json']);if(failure==='before')throw Error();gist.files['fee-console-ratio-snapshot.json']={content:body.files['fee-console-ratio-snapshot.json'].content};gist.history[0].version='b'.repeat(40);if(failure==='after')throw Error();}if(readFailure)throw Error();return structuredClone(gist);}};
    vm.createContext(ctx);vm.runInContext(code+'\nthis.ops={preview:previewRatioSnapshot,confirm:confirmRatioSnapshot,read:renderIndependentRatio,check:checkRatioSnapshotOutcome,clear:clearRatioSnapshotReview,setFiles(v){_ratioSnapshotFiles=v;},review(){return _ratioSnapshotReview;},pending(){return _ratioSnapshotUnknown;}};',ctx);
    const file=b=>({size:b.length,text:async()=>Buffer.from(b).toString(),arrayBuffer:async()=>new Uint8Array(b).buffer});
    ctx.ops.setFiles({candidate:file(Buffer.from(JSON.stringify(f.packet))),original:file(fs.readFileSync(f.plan.source.path)),input:file(fs.readFileSync(f.plan.input.path))});
    return {ctx,elements,calls,gist,original,setAllowed:v=>allowed=v,advance:ms=>clock+=ms,fail:v=>failure=v,readFail:v=>readFailure=v,patches:()=>calls.filter(c=>c.method==='PATCH').length};
  }
  const h=harness();assert.equal(await h.ctx.ops.preview({isTrusted:false}),false);assert.equal(h.calls.length,0);
  assert.equal(await h.ctx.ops.preview({isTrusted:true}),true);assert.equal(h.patches(),0);assert.equal(h.elements.get('ratioSnapshotConsent').checked,false);
  assert.equal(await h.ctx.ops.confirm({isTrusted:true}),false);assert.equal(h.patches(),0);
  h.elements.get('ratioSnapshotConsent').checked=true;assert.equal(await h.ctx.ops.confirm({isTrusted:true}),true);assert.equal(h.patches(),1);assert.equal(JSON.stringify(h.gist.files['original-ledger.json']),h.original);
  assert.equal(await h.ctx.ops.read(),true);assert.match(h.elements.get('ratioContent').innerHTML,/四类资产配置总览/);assert.match(h.elements.get('ratioNotice').textContent,/来源截至/);
  for(const mode of ['role','expiry','display','revision','no-consent']){
    const a=harness();assert.equal(await a.ctx.ops.preview({isTrusted:true}),true);a.elements.get('ratioSnapshotConsent').checked=mode!=='no-consent';if(mode==='role')a.setAllowed(false);if(mode==='expiry')a.advance(300001);if(mode==='display')a.elements.get('ratioSnapshotSummary').textContent='altered';if(mode==='revision')a.gist.history[0].version='f'.repeat(40);
    assert.equal(await a.ctx.ops.confirm({isTrusted:true}),false);assert.equal(a.patches(),0,mode);
  }
  const uncertain=harness();assert.equal(await uncertain.ctx.ops.preview({isTrusted:true}),true);uncertain.elements.get('ratioSnapshotConsent').checked=true;uncertain.fail('after');assert.equal(await uncertain.ctx.ops.confirm({isTrusted:true}),false);assert.equal(uncertain.patches(),1);assert.ok(uncertain.ctx.ops.pending());assert.equal(await uncertain.ctx.ops.preview({isTrusted:true}),false);assert.equal(await uncertain.ctx.ops.check({isTrusted:true}),true);assert.equal(uncertain.patches(),1);
  const bad=harness();bad.gist.files['fee-console-ratio-snapshot.json']={content:'{}'};assert.equal(await bad.ctx.ops.read(),true);assert.equal(bad.elements.get('ratioContent').innerHTML,'');assert.match(bad.elements.get('ratioNotice').textContent,/失败/);assert.equal(bad.patches(),0);
});

test('independent factories are embedded exactly and no source plaintext or fee files enter the protected PATCH',{skip:!independentRatioUi},async()=>{
  for(const name of ['fee-ratio-source-core.mjs','fee-ratio-snapshot.mjs'])assert.ok(unifiedUiSource.includes(fs.readFileSync(new URL('./'+name,import.meta.url),'utf8').split('export ',2)[1].trim()),name);
  const a=unifiedUiSource.indexOf('async function ghApi('),b=unifiedUiSource.indexOf('\n}',a)+2,raw='{"syntheticCipherOnly":true}',gid='0'.repeat(32),op={gid,token:'invented-token',epoch:1,raw};
  let calls=0;const values={gid,tok:'invented-token'},ctx={_ledgerBusy:false,_draftBlocked:false,EDIT:{},_fundRemoteWrite:null,_legacyMigrationPending:null,_ratioRecipientWrite:null,_ratioSnapshotWrite:op,_sourceEpoch:1,RATIO_RECIPIENT_FILE:'fee-console-ratio-recipient.json',RATIO_SNAPSHOT_FILE:'fee-console-ratio-snapshot.json',ratioAuthorized:()=>true,managerDocumentsAuthorized:()=>true,cfg:k=>values[k]||'',K:{gid:'gid',tok:'tok'},Object,JSON,Error,String,fetch:async(url,o)=>{calls++;assert.equal(url,'https://api.github.com/gists/'+gid);assert.equal(o.headers.Authorization,'Bearer invented-token');assert.equal(o.reviewedRatioSnapshot,undefined);assert.deepEqual(Object.keys(JSON.parse(o.body).files),['fee-console-ratio-snapshot.json']);return {ok:true,status:200,json:async()=>({})};}};
  vm.createContext(ctx);vm.runInContext(unifiedUiSource.slice(a,b)+'\nthis.run=ghApi;',ctx);
  const body=JSON.stringify({files:{'fee-console-ratio-snapshot.json':{content:raw}}});
  await ctx.run('/gists/'+gid,{method:'PATCH',body,reviewedRatioSnapshot:op});assert.equal(calls,1);
  for(const opt of [{method:'PATCH',body},{method:'PATCH',body,reviewedRatioSnapshot:{...op}},{method:'PATCH',body:JSON.stringify({files:{'data.json':{content:raw}}}),reviewedRatioSnapshot:op},{method:'PATCH',body:JSON.stringify({files:{'fee-console-ratio-snapshot.json':{content:raw},'fee-data-health.json':{content:raw}}}),reviewedRatioSnapshot:op},{method:'PATCH',body,headers:{},reviewedRatioSnapshot:op}])await assert.rejects(ctx.run('/gists/'+gid,opt));
  await assert.rejects(ctx.run('/gists/'+'1'.repeat(32),{method:'PATCH',body,reviewedRatioSnapshot:op}));assert.equal(calls,1);
});
test('independent proof evidence is immutable and exact JSON refuses duplicate keys before association',async t=>{
  const f=await independentFixture(t);assert.ok(Object.isFrozen(f.proof));assert.ok(Object.isFrozen(f.proof.evidence));assert.throws(()=>{f.proof.evidence.modelSha256='0'.repeat(64);});
  const bytes=new TextEncoder().encode('{"schema":"one","schema":"two"}');await assert.rejects(f.snapshot.verifyOriginal({...f.args,originalBytes:bytes,sourceSha256:await f.snapshot.digestBytes(bytes)}));
  const p=await f.snapshot.authenticate(f.packet,f.proof,f.manager,f.options);for(const watermark of [{version:1,id:'0'.repeat(64),sourceDate:'invalid',capturedAt:'bad'},{version:-1,id:'0'.repeat(64),sourceDate:'2000-01-01',capturedAt:'2000-01-01T00:00:00.000Z'}])await assert.rejects(f.snapshot.verify(p,f.manager,{watermark,now:f.now}));
});


test('retired independent action entry is inert and links to the manager app without forwarding secrets',()=>{
  const page=fs.readFileSync(new URL('../xuan-ib/index.html',import.meta.url),'utf8');
  if(!page.includes('name="xuan-action-status" content="retired"')){assert.ok(page.includes('const encryptedRoot ='),'only the pre-retirement audited loader is compatible');return;}
  assert.match(page,/<h1>独立行动版已停止<\/h1>/);assert.match(page,/历史文件保留归档/);
  assert.doesNotMatch(page,/<(?:script|iframe|form|input)\b/i);assert.doesNotMatch(page,/http-equiv=["']refresh|action\.enc\.json|localStorage|sessionStorage|fetch\(|location\./i);
  assert.match(page,/default-src 'none'/);assert.match(page,/base-uri 'none'/);
  const links=[...page.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(links,['../']);assert.ok(links.every(x=>!/[?#:]/.test(x)));
  for(const name of ['latest.html','latest.meta.json','action.enc.json'])assert.ok(fs.existsSync(new URL('../xuan-ib/'+name,import.meta.url)),'historical file preserved: '+name);
});
