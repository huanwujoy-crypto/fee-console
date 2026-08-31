import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  ACCEPTED_SUMMARY, DEFERRED_SUMMARY, RESPONSE_TTL_MS, buildDecisionMenu,
  validateDecisionRequest, parseDecisionJson, decisionRequestDigest, deriveReceiptId,
  checkDecisionRequestReplay, buildPublishedDecisionMenu
} from './xuan-ib-decision-menu.mjs';

const DATE = '2026-08-31';
const NOW = Date.parse('2026-08-31T10:00:00+08:00');
const ID = 'D-20260831-DEMO-ONE';
const ID2 = 'D-20260831-DEMO-TWO';
const UUID = 'da5bf7f2-41e2-472c-b83c-7456aa7ea0c5';
const blob = html => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');

function fixture({ decisions = [{ decisionId: ID, status: 'awaiting_user' }], interaction = 'enabled', cards, rawState, receipts = [] } = {}) {
  const state = { schemaVersion: 1, interaction, decisions, receipts };
  const html = `<!doctype html><html><head><title>XUAN-投资管理</title><style>p{color:red}</style></head><body><!-- xuan-ib-handover:v1 -->
  <span class="date">${DATE} 周一 · 演示版</span>
  <div class="pane p4">${cards ?? decisions.map((item, index) => `<details class="dcard" id="${item.decisionId}" data-decision-id="${item.decisionId}" data-decision-status="${item.status}"><summary>${index + 1} · 测试<b>事项</b> ${index + 1}<span class="rt">建议 (B) 保留现行规则 · 待审核</span></summary><div class="dbody"><p><b class="lab">事实/选项：</b>这是演示，不是真实投资意见。</p><p><b class="lab">Claude 意见：</b>保留<b>现行规则</b>，先补齐信息。</p></div></details>`).join('')}</div>
  <template id="xuan-ib-decision-state-v1" type="application/json">${rawState ?? JSON.stringify(state)}</template></body></html>`;
  return { html, meta: { schemaVersion: 1, sourceSha: 'a'.repeat(40), sourceCommitEpoch: Math.floor(NOW / 1000) - 600, dataDate: DATE, htmlBlob: blob(html) } };
}

function mutate(base, transform) {
  const html = transform(base.html);
  return { html, meta: { ...base.meta, htmlBlob: blob(html) } };
}
function request(base, overrides = {}) {
  return {
    schemaVersion: 1, kind: 'xuan-ib-decision-response', requestId: UUID,
    sourceSha: base.meta.sourceSha, htmlBlob: base.meta.htmlBlob,
    submittedAt: '2026-08-31T10:00:00+08:00',
    selections: [{ decisionId: ID, action: 'accepted', publicSummary: ACCEPTED_SUMMARY }],
    ...overrides
  };
}
const check = (base, input = request(base), options = {}) => validateDecisionRequest(input, { ...base, now: NOW, ...options });

test('manifest uses stable IDs and exact tree text, excluding the status/recommendation badge', () => {
  const base = fixture();
  const original = structuredClone(base);
  assert.deepEqual(buildDecisionMenu(base), {
    schemaVersion: 1, kind: 'xuan-ib-decision-menu', sourceSha: 'a'.repeat(40),
    htmlBlob: base.meta.htmlBlob, dataDate: DATE, interaction: 'enabled',
    pending: [{ decisionId: ID, title: '测试事项 1', recommendation: '保留现行规则，先补齐信息。' }]
  });
  assert.deepEqual(base, original, 'read-only construction must not mutate report or metadata');
});

test('zero pending produces an empty menu, never reopens resolved decisions', () => {
  const base = fixture({ decisions: [] });
  assert.deepEqual(buildDecisionMenu(base).pending, []);
  assert.throws(() => check(base, request(base, { selections: [] })), /1 to 50 explicit/);
  assert.throws(() => check(base), /not a current awaiting_user/);
});

test('manifest preserves original decision order and stable IDs rather than visible numbers', () => {
  const base = fixture({ decisions: [{ decisionId: ID2, status: 'awaiting_user' }, { decisionId: ID, status: 'awaiting_user' }] });
  assert.deepEqual(buildDecisionMenu(base).pending.map(item => item.decisionId), [ID2, ID]);
});

test('HTML nested details do not make a sibling recommendation leak into the card', () => {
  const base = mutate(fixture({ decisions: [{ decisionId: ID, status: 'awaiting_user' }, { decisionId: ID2, status: 'awaiting_user' }] }), html => html.replace('<div class="dbody">', '<details><summary>背景</summary><p>嵌套内容</p></details><div class="dbody">'));
  const menu = buildDecisionMenu(base);
  assert.equal(menu.pending.length, 2);
  assert.equal(menu.pending[0].title, '测试事项 1');
  assert.equal(menu.pending[1].recommendation, '保留现行规则，先补齐信息。');
});

test('comments and script raw text cannot create fake decision elements', () => {
  const base = mutate(fixture(), html => html.replace('<div class="pane p4">', '<!-- <details data-decision-id="fake"> --> <script>const fake = "<details data-decision-id=\"fake\">";</script><div class="pane p4">'));
  assert.equal(buildDecisionMenu(base).pending.length, 1);
});

test('entity decoding and quoted greater-than characters retain DOM text', () => {
  const base = mutate(fixture(), html => html.replace('测试<b>事项</b>', '测试&#x4e8b;项 &amp; 核查').replace('<b class="lab">Claude 意见：</b>', '<b class="lab" title="a > b">Claude 意见：</b>'));
  assert.equal(buildDecisionMenu(base).pending[0].title, '测试事项 & 核查 1');
});

test('missing or duplicate explicit recommendation fails closed without guessing', () => {
  assert.throws(() => buildDecisionMenu(mutate(fixture(), html => html.replace('Claude 意见：', '其它内容：'))), /recommendation.*unique/);
  assert.throws(() => buildDecisionMenu(mutate(fixture(), html => html.replace('</div></details>', '<p><b class="lab">Claude 意见：</b>另一意见</p></div></details>'))), /recommendation.*unique/);
});

test('duplicate summary, malformed nesting and duplicate card identity fail closed', () => {
  assert.throws(() => buildDecisionMenu(mutate(fixture(), html => html.replace('<div class="dbody">', '<summary>另一个标题</summary><div class="dbody">'))), /summary.*unique/);
  assert.throws(() => buildDecisionMenu(mutate(fixture(), html => html.replace('</b>，先', '</p>，先'))), /unbalanced/);
  assert.throws(() => buildDecisionMenu(mutate(fixture(), html => html.replace('<div class="pane p4">', `<div id="${ID}" class="pane p4">`))), /identity\/status/);
});

test('pair mismatch, invalid metadata date and header disagreement are rejected', () => {
  const base = fixture();
  assert.throws(() => buildDecisionMenu({ ...base, html: base.html + ' ' }), /not the same publication/);
  assert.throws(() => buildDecisionMenu({ ...base, meta: { ...base.meta, dataDate: '2026-02-30' } }), /metadata/);
  assert.throws(() => buildDecisionMenu({ ...base, meta: { ...base.meta, dataDate: '2026-08-30' } }), /data date/);
  assert.throws(() => buildDecisionMenu({ ...base, meta: { ...base.meta, extra: true } }), /unknown fields/);
});

test('duplicate machine JSON keys, duplicate attributes, non-inert template are rejected', () => {
  const base = fixture();
  assert.throws(() => buildDecisionMenu(mutate(base, html => html.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))), /duplicate key/);
  assert.throws(() => buildDecisionMenu(mutate(base, html => html.replace(`id="${ID}"`, `id="${ID}" id="${ID}"`))), /duplicate HTML attribute/);
  assert.throws(() => buildDecisionMenu(mutate(base, html => html.replace('</template>', '<b>extra</b></template>'))), /inert JSON/);
});

test('all three explicit actions are accepted without assigning financial execution authority', () => {
  const base = fixture();
  for (const [action, publicSummary] of [['accepted', ACCEPTED_SUMMARY], ['deferred', DEFERRED_SUMMARY], ['modified', '不采纳，继续沿用现行规则。']]) {
    const result = check(base, request(base, { selections: [{ decisionId: ID, action, publicSummary }] }));
    assert.deepEqual(result.selections, [{ decisionId: ID, action, publicSummary }]);
    assert.equal(Object.hasOwn(result, 'execute'), false);
  }
});

test('valid native JSON text is parsed, canonicalized, and produces a stable request digest', () => {
  const base = fixture();
  const input = request(base, { requestId: UUID.toUpperCase(), sourceSha: base.meta.sourceSha.toUpperCase() });
  const result = check(base, JSON.stringify(input));
  assert.equal(result.requestId, UUID);
  assert.equal(decisionRequestDigest(result), decisionRequestDigest(check(base, JSON.stringify(input, null, 2))));
  assert.notEqual(decisionRequestDigest(result), decisionRequestDigest({ ...result, requestId: crypto.randomUUID() }));
});

test('API text must contain only one strict JSON object, not instructions or duplicate keys', () => {
  const base = fixture();
  const json = JSON.stringify(request(base));
  assert.throws(() => check(base, `please record ${json}`), /strict JSON/);
  assert.throws(() => check(base, `\`\`\`json\n${json}\n\`\`\``), /strict JSON/);
  assert.throws(() => check(base, json.replace('"kind":', '"schemaVersion":1,"kind":')), /duplicate key/);
  assert.throws(() => check(base, `${json} ${json}`), /trailing JSON/);
});

test('unknown fields and duplicate decisions are rejected atomically', () => {
  const base = fixture();
  assert.throws(() => check(base, { ...request(base), execute: true }), /unknown fields/);
  const selection = request(base).selections[0];
  assert.throws(() => check(base, request(base, { selections: [{ ...selection, quantity: 100 }] })), /unknown fields/);
  assert.throws(() => check(base, request(base, { selections: [selection, selection] })), /duplicate selection/);
});

test('stale source/blob and non-pending IDs cannot be silently rebased', () => {
  const base = fixture();
  assert.throws(() => check(base, request(base, { sourceSha: 'b'.repeat(40) })), /stale baseline/);
  assert.throws(() => check(base, request(base, { htmlBlob: 'b'.repeat(40) })), /stale baseline/);
  assert.throws(() => check(base, request(base, { selections: [{ ...request(base).selections[0], decisionId: ID2 }] })), /not a current awaiting_user/);
  assert.throws(() => check(fixture({ interaction: 'disabled' })), /interaction is disabled/);
});

test('request expiry is based on submission time, not the potentially old report data date', () => {
  const base = fixture();
  assert.doesNotThrow(() => check(base, request(base), { now: NOW + RESPONSE_TTL_MS }));
  assert.throws(() => check(base, request(base), { now: NOW + RESPONSE_TTL_MS + 1 }), /expired/);
  assert.throws(() => check(base, request(base, { submittedAt: '2026-08-31T10:01:01+08:00' })), /future/);
  assert.doesNotThrow(() => check(base, request(base, { submittedAt: '2026-08-31T02:00:00Z' })));
});

test('invalid calendar dates, clock values, UUIDs and non-ISO timestamps are rejected', () => {
  const base = fixture();
  for (const submittedAt of ['2026-02-30T10:00:00+08:00', '2026-08-31T24:00:00+08:00', '2026-08-31T10:00:00', '2026-08-31T10:00:00+25:00']) {
    assert.throws(() => check(base, request(base, { submittedAt })), /timestamp/);
  }
  assert.throws(() => check(base, request(base, { requestId: 'not-a-uuid' })), /identity/);
});

test('Skip, cancelled, empty selection and opening custom input cannot become recorded choices', () => {
  const base = fixture();
  for (const action of ['skip', 'cancelled', 'accept', 'rejected', '', null]) {
    assert.throws(() => check(base, request(base, { selections: [{ decisionId: ID, action, publicSummary: ACCEPTED_SUMMARY }] })), /action must/);
  }
  assert.throws(() => check(base, request(base, { selections: [] })), /explicit selections/);
  assert.throws(() => check(base, request(base, { selections: [{ decisionId: ID, action: 'modified', publicSummary: '' }] })), /1 to 120/);
});

test('accepted/deferred require exact fixed summaries; modified requires safe public text', () => {
  const base = fixture();
  for (const action of ['accepted', 'deferred']) {
    assert.throws(() => check(base, request(base, { selections: [{ decisionId: ID, action, publicSummary: '任意其它摘要' }] })), /fixed publicSummary/);
  }
  const bad = ['买入测试标的', '卖出 10 股', 'Transfer now', '$100', 'https://example.test', '<b>意见</b>', 'a&b', 'token: secret', '账户12345678', 'a\u200bb', '先记录\n再改', ' '];
  for (const publicSummary of bad) {
    assert.throws(() => check(base, request(base, { selections: [{ decisionId: ID, action: 'modified', publicSummary }] })), /publicSummary/);
  }
});

test('Unicode length counts code points rather than UTF-16 units and rejects lone surrogates', () => {
  const base = fixture();
  const withSummary = publicSummary => request(base, { selections: [{ decisionId: ID, action: 'modified', publicSummary }] });
  assert.doesNotThrow(() => check(base, withSummary('😀'.repeat(120))));
  assert.throws(() => check(base, withSummary('😀'.repeat(121))), /1 to 120/);
  assert.throws(() => check(base, withSummary('\ud800')), /unsafe characters/);
});

test('public summaries reject bare account IDs, email contacts, and Chinese-adjacent quantities', () => {
  const base = fixture();
  for (const publicSummary of ['持有10股腾讯', '账户为U6859001', '参考U6859001账户',
    '请联系demo.person@example.test', '限价100', '参考 USD 100', '账户是ABCD1234']) {
    assert.throws(() => check(base, request(base, {
      selections: [{ decisionId: ID, action: 'modified', publicSummary }]
    })), /publicSummary/);
  }
  assert.doesNotThrow(() => check(base, request(base, {
    selections: [{ decisionId: ID, action: 'modified', publicSummary: '继续研究股息率和家庭配置口径。' }]
  })));
});

test('strict JSON rejects oversized and deeply nested inputs', () => {
  assert.throws(() => parseDecisionJson(' '.repeat(65_537)), /65536/);
  assert.throws(() => parseDecisionJson('['.repeat(40) + '0' + ']'.repeat(40)), /nesting exceeds/);
});

function recordedFixture(input, { omit = [], override = {} } = {}) {
  const receipts = input.selections.filter(item => !omit.includes(item.decisionId)).map(item => ({
    receiptId: deriveReceiptId(input, item.decisionId), decisionId: item.decisionId, action: item.action,
    responseToSourceSha: input.sourceSha, responseToHtmlBlob: input.htmlBlob,
    recordedAtHkt: '2026-08-31T10:00:10+08:00', publicSummary: item.publicSummary, ...override
  }));
  const decisions = input.selections.map(item => ({ decisionId: item.decisionId,
    status: item.action === 'deferred' || omit.includes(item.decisionId) ? 'awaiting_user' : item.action }));
  return fixture({ decisions, receipts });
}

test('receipt ID is deterministic, HKT-dated, normalized, and compatible with the existing schema', () => {
  const base = fixture();
  const input = request(base);
  const id = deriveReceiptId(input, ID);
  assert.match(id, /^R-20260831-100000-[A-F0-9]{8}$/);
  assert.equal(id, deriveReceiptId({ ...input, requestId: UUID.toUpperCase(), submittedAt: '2026-08-31T02:00:00Z' }, ID));
  assert.notEqual(id, deriveReceiptId(input, ID2));
  assert.notEqual(id, deriveReceiptId({ ...input, requestId: crypto.randomUUID() }, ID));
  assert.equal(deriveReceiptId({ ...input, submittedAt: '2026-08-31T23:30:00Z' }, ID).slice(0, 18), 'R-20260901-073000-');
});

test('exact published replay acknowledges without validating freshness or generating another receipt', () => {
  const original = fixture();
  const input = request(original);
  const current = recordedFixture(input);
  const before = structuredClone(current);
  assert.deepEqual(checkDecisionRequestReplay(JSON.stringify(input), current), {
    status: 'already_recorded', receiptIds: [deriveReceiptId(input, ID)]
  });
  assert.notEqual(current.meta.htmlBlob, input.htmlBlob);
  assert.throws(() => check(current, input, { now: NOW + RESPONSE_TTL_MS + 1 }), /expired/);
  assert.deepEqual(current, before);
});

test('unrecorded stale requests remain rejected; no receipt match does not authorize anything', () => {
  const original = fixture();
  const input = request(original);
  const current = mutate(original, html => html.replace('演示版', '演示新版'));
  assert.equal(checkDecisionRequestReplay(input, current).status, 'not_recorded');
  assert.throws(() => check(current, input), /stale baseline/);
});

test('all recorded batch selections must match, including bound source and exact public summary', () => {
  const original = fixture({ decisions: [{ decisionId: ID, status: 'awaiting_user' }, { decisionId: ID2, status: 'awaiting_user' }] });
  const input = request(original, { selections: [
    { decisionId: ID, action: 'accepted', publicSummary: ACCEPTED_SUMMARY },
    { decisionId: ID2, action: 'deferred', publicSummary: DEFERRED_SUMMARY }
  ] });
  assert.equal(checkDecisionRequestReplay(input, recordedFixture(input)).status, 'already_recorded');
  assert.throws(() => checkDecisionRequestReplay(input, recordedFixture(input, { omit: [ID2] })), /partial request/);
  assert.throws(() => checkDecisionRequestReplay(input, recordedFixture(input, { override: { responseToSourceSha: 'c'.repeat(40) } })), /identity conflict/);
  assert.throws(() => checkDecisionRequestReplay(input, recordedFixture(input, { override: { publicSummary: '另一个安全摘要' } })), /identity conflict/);
});

test('same requestId with changed action cannot collide silently with a published receipt', () => {
  const original = fixture();
  const input = request(original);
  const current = recordedFixture(input);
  const changed = request(original, { selections: [{ decisionId: ID, action: 'modified', publicSummary: '不采纳，沿用原规则。' }] });
  assert.throws(() => checkDecisionRequestReplay(changed, current), /identity conflict/);
});

test('malformed resolved state and mismatched receipt status are rejected before replay', () => {
  assert.throws(() => buildDecisionMenu(fixture({ decisions: [{ decisionId: ID, status: 'accepted' }] })), /missing its receipt/);
  const original = fixture();
  const input = request(original);
  const current = recordedFixture(input);
  const mismatched = mutate(current, html => html.replaceAll('"accepted"', '"awaiting_user"'));
  assert.throws(() => checkDecisionRequestReplay(input, mismatched), /receipt|action/);
});

test('new UUID retry of the same content key returns actual existing receipt IDs', () => {
  const original = fixture();
  const input = request(original);
  const current = recordedFixture(input);
  const repeated = { ...input, requestId: crypto.randomUUID(), submittedAt: '2026-08-31T10:05:00+08:00' };
  assert.deepEqual(checkDecisionRequestReplay(repeated, current), {
    status: 'already_recorded', receiptIds: [deriveReceiptId(input, ID)]
  });
  assert.notEqual(deriveReceiptId(repeated, ID), deriveReceiptId(input, ID));
  assert.throws(() => check(current, repeated, { now: NOW + 300_000 }), /stale baseline/);
});

test('partial content-key replay with a new request ID fails closed for reconciliation', () => {
  const original = fixture({ decisions: [{ decisionId: ID, status: 'awaiting_user' }, { decisionId: ID2, status: 'awaiting_user' }] });
  const input = request(original, { selections: [
    { decisionId: ID, action: 'accepted', publicSummary: ACCEPTED_SUMMARY },
    { decisionId: ID2, action: 'deferred', publicSummary: DEFERRED_SUMMARY }
  ] });
  const current = recordedFixture(input, { omit: [ID2] });
  assert.throws(() => checkDecisionRequestReplay({ ...input, requestId: crypto.randomUUID() }, current), /partial request/);
});

test('successful published menu is explicitly available, including a true empty menu', () => {
  assert.equal(buildPublishedDecisionMenu(fixture()).available, true);
  const empty = buildPublishedDecisionMenu(fixture({ decisions: [] }));
  assert.equal(empty.available, true);
  assert.equal(empty.interaction, 'enabled');
  assert.deepEqual(empty.pending, []);
});

test('menu extraction failure returns an explicit disabled same-pair fallback, not a fake empty success', () => {
  const invalid = mutate(fixture(), html => html.replace('Claude 意见：', '不唯一的结构：'));
  assert.throws(() => buildDecisionMenu(invalid), /recommendation.*unique/);
  const fallback = buildPublishedDecisionMenu(invalid);
  assert.equal(fallback.available, false);
  assert.equal(fallback.interaction, 'disabled');
  assert.deepEqual(fallback.pending, []);
  assert.equal(fallback.sourceSha, invalid.meta.sourceSha);
  assert.equal(fallback.htmlBlob, invalid.meta.htmlBlob);
  assert.match(fallback.unavailableReason, /暂不可用/);
  assert.equal(fallback.unavailableReason.includes('暂无待办'), false);
});

test('mismatched pair or malformed metadata cannot create even an unavailable published manifest', () => {
  const base = fixture();
  assert.throws(() => buildPublishedDecisionMenu({ ...base, html: base.html + ' ' }), /same publication/);
  assert.throws(() => buildPublishedDecisionMenu({ ...base, meta: { ...base.meta, sourceSha: 'bad' } }), /metadata/);
});

test('CLI validation outputs only validation result and receipt IDs, never the public input text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-menu-test-'));
  try {
    const base = fixture();
    const summary = '这是不应出现在验证日志内的确认摘要';
    const input = request(base, { submittedAt: new Date().toISOString(), selections: [{ decisionId: ID, action: 'modified', publicSummary: summary }] });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(base.meta));
    fs.writeFileSync(path.join(dir, 'report.html'), base.html);
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(input));
    const script = fileURLToPath(new URL('./xuan-ib-decision-menu.mjs', import.meta.url));
    const output = spawnSync(process.execPath, [script, 'validate', path.join(dir, 'meta.json'), path.join(dir, 'report.html'), path.join(dir, 'request.json')], { encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), { status: 'valid', selectionCount: 1, receiptIds: [deriveReceiptId(input, ID)] });
    assert.equal(`${output.stdout}${output.stderr}`.includes(summary), false);
    assert.equal(`${output.stdout}${output.stderr}`.includes(UUID), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
