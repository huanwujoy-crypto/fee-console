import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, 'handover-guard.mjs');
const validateWorkflow = fs.readFileSync(path.join(here, '../.github/workflows/validate-xuan-ib-handover.yml'), 'utf8');
const promoteWorkflow = fs.readFileSync(path.join(here, '../.github/workflows/promote-xuan-ib-handover.yml'), 'utf8');

const valid = (extra = '') => `<!doctype html>
<html><head><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN-投资管理</title><style>body{color:#111}</style></head>
<body><!-- xuan-ib-handover:v1 --><h1>XUAN-投资管理</h1><span class="date">2026-08-25 周二 · 21:00 HKT</span><p class="edition">睡前版</p><p class="asof">as-of 2026-08-25 21:00 HKT · 组合总额 $1,000 · 计算 1+1=2</p><p>${'完整简报 '.repeat(180)}</p>${extra}</body></html>
`;

const markRecordsUpdate = (html) => html.replace(
  '<!-- xuan-ib-handover:v1 -->',
  '<!-- xuan-ib-handover:v1 --><!-- xuan-ib-records-update:v1 -->'
);

const run = (html, date = '2026-08-25', continuity = null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-guard-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  const args = [guard, file, date];
  const env = { ...process.env };
  if (continuity?.previousHtml !== undefined) {
    const previousFile = path.join(dir, 'previous.html');
    fs.writeFileSync(previousFile, continuity.previousHtml);
    args.push(previousFile);
  }
  if (continuity?.sourceSha !== undefined) env.XUAN_IB_PREVIOUS_SOURCE_SHA = continuity.sourceSha;
  if (continuity?.htmlBlob !== undefined) env.XUAN_IB_PREVIOUS_HTML_BLOB = continuity.htmlBlob;
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env,
  });
};

const sourceSha = 'a'.repeat(40);
const htmlBlob = 'b'.repeat(40);
const decision = (decisionId, status) => ({ decisionId, status });
const receipt = (overrides = {}) => ({
  receiptId: 'R-20260830-154500-A1B2C3D4',
  decisionId: 'D-20260829-MRVL-CLASS',
  action: 'accepted',
  responseToSourceSha: sourceSha,
  responseToHtmlBlob: htmlBlob,
  recordedAtHkt: '2026-08-30T15:45:00+08:00',
  publicSummary: '采纳 Claude 意见；只记录，不执行',
  ...overrides,
});

const withDecisionState = ({
  interaction = 'disabled',
  decisions = [
    decision('D-20260829-MRVL-CLASS', 'accepted'),
    decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
  ],
  receipts = [receipt()],
  stateOverrides = {},
  badge,
  markupOverrides = {},
  rawJson,
  recordsUpdate = false,
} = {}) => {
  const awaiting = decisions.filter((item) => item.status === 'awaiting_user').length;
  const cards = decisions.map((item) => {
    const renderedId = markupOverrides[item.decisionId]?.id ?? item.decisionId;
    const renderedDecisionId = markupOverrides[item.decisionId]?.decisionId ?? item.decisionId;
    const renderedStatus = markupOverrides[item.decisionId]?.status ?? item.status;
    return `<details class="dcard" id="${renderedId}" data-decision-id="${renderedDecisionId}" data-decision-status="${renderedStatus}"><summary>${item.decisionId}</summary></details>`;
  }).join('');
  const state = {
    schemaVersion: 1,
    interaction,
    decisions,
    receipts,
    ...stateOverrides,
  };
  const html = valid(`<label for="s4" aria-label="待办：${badge ?? awaiting} 项">待办 <span class="dot">${badge ?? awaiting}</span></label>${cards}<template id="xuan-ib-decision-state-v1">${rawJson ?? JSON.stringify(state)}</template>`);
  return recordsUpdate ? markRecordsUpdate(html) : html;
};

const withDecisionDisplayGroups = ({ decisions, receipts = [], recordsUpdate = false }) => {
  const card = (item) => {
    const label = item.status === 'awaiting_user' ? '待 Wu 审核'
      : item.status === 'rejected' ? '已拒绝 / 已结案'
        : item.status === 'superseded' ? '已取代 / 已结案' : '已决定 / 待落实';
    return `<details class="dcard" id="${item.decisionId}" data-decision-id="${item.decisionId}" data-decision-status="${item.status}"><summary>${item.decisionId}<span class="rt wv">建议 B · ${label}</span></summary><div class="dbody"><p><b class="lab">Claude 意见：</b>建议正文固定且不得修改</p><p><b class="lab">状态：</b><b>${label}</b>（<code>${item.status}</code>；只记录意见）</p></div></details>`;
  };
  const awaiting = decisions.filter((item) => item.status === 'awaiting_user');
  const resolved = decisions.filter((item) => item.status !== 'awaiting_user');
  const state = { schemaVersion: 1, interaction: 'enabled', decisions, receipts };
  const label = `<label for="s4" aria-label="待办：${awaiting.length} 项">待办 <span class="dot">${awaiting.length}</span></label>`;
  const legacy = `<h2>⑤ 待决定事项 <small>${awaiting.length} 项待 Wu 裁决 · 展开查看</small></h2>${decisions.map(card).join('')}`;
  const grouped = `${decisionGroupMarkerForTest('awaiting_user', 'start')}<h2 data-decision-group-title="awaiting_user">⑤ 待决定事项 <small>${awaiting.length} 项待 Wu 裁决</small></h2>${awaiting.map(card).join('')}${decisionGroupMarkerForTest('awaiting_user', 'end')}${decisionGroupMarkerForTest('resolved', 'start')}<h2 data-decision-group-title="resolved">已决定 / 待落实 <small>${resolved.length} 项 · 只记录意见，不执行交易</small></h2>${resolved.map(card).join('')}${decisionGroupMarkerForTest('resolved', 'end')}`;
  const html = valid(`${label}${recordsUpdate ? grouped : legacy}<template id="xuan-ib-decision-state-v1" type="application/json">${JSON.stringify(state)}</template>`);
  return recordsUpdate ? markRecordsUpdate(html) : html;
};

function decisionGroupMarkerForTest(status, edge) {
  return `<!-- xuan-ib-decision-group:v1:${status}:${edge} -->`;
}

test('accepts a self-contained dated handover', () => {
  const result = run(valid());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects the retired product title once the rename has landed', () => {
  const result = run(valid().replace('<title>XUAN-投资管理</title>', '<title>XUAN-IB 睡前交接</title>'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved title/);
});

test('rejects the retired iPhone home-screen title', () => {
  const result = run(valid().replace('content="XUAN-投资管理"', 'content="XUAN-IB 交接"'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /iPhone home-screen title/);
});

test('rejects the wrong data date', () => {
  const result = run(valid(), '2026-08-24');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary data-date header/);
});

test('rejects a stale primary date even if the expected date appears elsewhere', () => {
  const html = valid('<p>备注日期 2026-08-26</p>').replace(
    '<span class="date">2026-08-25',
    '<span class="date">2026-08-24'
  );
  const result = run(html, '2026-08-26');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary data-date header/);
});

test('rejects more than one primary date header', () => {
  const result = run(valid('<span class="date">2026-08-25 duplicate</span>'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary data-date header/);
});

test('ignores a fake date element hidden inside a script or comment', () => {
  const html = valid('<script>const fake = `<span class="date">2026-08-26</span>`;</script><!-- <span class="date">2026-08-26</span> -->')
    .replace('<span class="date">2026-08-25', '<span class="date">2026-08-24');
  const result = run(html, '2026-08-26');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary data-date header/);
});

test('rejects a page that cannot be installed like the fee console', () => {
  const result = run(valid().replace('<meta name="apple-mobile-web-app-capable" content="yes">', ''));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /iPhone web-app capability/);
});

test('rejects outbound network code', () => {
  const result = run(valid('<script>fetch("/collect")</script>'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /network call/);
});

test('rejects embedded credentials', () => {
  const result = run(valid('<p>github_pat_1234567890abcdefghij</p>'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub credential/);
});

test('rejects external frames and URLs', () => {
  const result = run(valid('<iframe src="https://example.com"></iframe>'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frame or object|external URL/);
});


test('rejects protocol-relative and automatic remote resources', () => {
  const result = run(valid('<img src="//example.com/leak">'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /protocol-relative URL|remote resource/);
});

test('accepts a strict optional decision state with a bound receipt', () => {
  const result = run(withDecisionState({ interaction: 'enabled' }));
  assert.equal(result.status, 0, result.stderr);

  const typedTemplate = withDecisionState({ interaction: 'enabled' }).replace(
    '<template id="xuan-ib-decision-state-v1">',
    '<template id="xuan-ib-decision-state-v1" type="application/json">'
  );
  const typedResult = run(typedTemplate);
  assert.equal(typedResult.status, 0, typedResult.stderr);
});

test('rejects duplicate or unknown decision state fields', () => {
  const unknown = run(withDecisionState({ stateOverrides: { unexpected: true } }));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /missing or unknown fields/);

  const rawJson = '{"schemaVersion":1,"schemaVersion":1,"interaction":"disabled","decisions":[],"receipts":[]}';
  const duplicate = run(withDecisionState({ decisions: [], receipts: [], rawJson }));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate key/);
});

test('rejects missing, unknown, or repeated decision templates', () => {
  const invalidInteraction = run(withDecisionState({ interaction: 'ready' }));
  assert.notEqual(invalidInteraction.status, 0);
  assert.match(invalidInteraction.stderr, /interaction/);

  const repeated = withDecisionState().replace(
    '</body>',
    '<template id="xuan-ib-decision-state-v1">{"schemaVersion":1}</template></body>'
  );
  const result = run(repeated);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /template must be unique/);

  const executableType = run(withDecisionState().replace(
    '<template id="xuan-ib-decision-state-v1">',
    '<template id="xuan-ib-decision-state-v1" type="text/html">'
  ));
  assert.notEqual(executableType.status, 0);
  assert.match(executableType.stderr, /type must be application\/json/);
});

test('rejects malformed, duplicate, and unknown decision fields', () => {
  const malformed = run(withDecisionState({
    decisions: [decision('bad-id', 'awaiting_user')],
    receipts: [],
  }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /invalid decisionId/);

  const duplicated = run(withDecisionState({
    decisions: [
      decision('D-20260829-DUPLICATE', 'awaiting_user'),
      decision('D-20260829-DUPLICATE', 'awaiting_user'),
    ],
    receipts: [],
  }));
  assert.notEqual(duplicated.status, 0);
  assert.match(duplicated.stderr, /decisionId values must be unique/);

  const unknownStatus = run(withDecisionState({
    decisions: [decision('D-20260829-UNKNOWN', 'deferred')],
    receipts: [],
  }));
  assert.notEqual(unknownStatus.status, 0);
  assert.match(unknownStatus.stderr, /invalid status/);

  const extraField = run(withDecisionState({
    decisions: [{ ...decision('D-20260829-EXTRA', 'awaiting_user'), note: 'no' }],
    receipts: [],
  }));
  assert.notEqual(extraField.status, 0);
  assert.match(extraField.stderr, /missing or unknown fields/);

  const missingReceipt = run(withDecisionState({
    decisions: [decision('D-20260829-EXTRA', 'accepted')],
    receipts: [],
  }));
  assert.notEqual(missingReceipt.status, 0);
  assert.match(missingReceipt.stderr, /must have a receipt/);
});

test('rejects duplicate, orphaned, malformed, and unknown receipt fields', () => {
  const duplicated = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt(), receipt()],
  }));
  assert.notEqual(duplicated.status, 0);
  assert.match(duplicated.stderr, /receiptId values must be unique/);

  const orphaned = run(withDecisionState({
    decisions: [decision('D-20260829-OTHER', 'awaiting_user')],
    receipts: [receipt()],
  }));
  assert.notEqual(orphaned.status, 0);
  assert.match(orphaned.stderr, /orphaned/);

  const action = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt({ action: 'rejected' })],
  }));
  assert.notEqual(action.status, 0);
  assert.match(action.stderr, /invalid action/);

  const extra = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [{ ...receipt(), schemaVersion: 1 }],
  }));
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /missing or unknown fields/);
});

test('rejects non-40-hex trusted receipt pairs', () => {
  const result = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt({ responseToHtmlBlob: 'not-a-hash' })],
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid trusted pair/);
});

test('strictly validates HKT timestamps', () => {
  for (const recordedAtHkt of [
    '2026-08-30T15:45:00Z',
    '2026-02-30T15:45:00+08:00',
    '2026-08-30T25:45:00+08:00',
  ]) {
    const result = run(withDecisionState({
      decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
      receipts: [receipt({ recordedAtHkt })],
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid HKT timestamp/);
  }
});

test('counts publicSummary by Unicode code points and rejects dangerous content', () => {
  const accepted = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt({ publicSummary: '🙂'.repeat(120) })],
  }));
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const publicSummary of [
    '🙂'.repeat(121),
    '查看 https://example.com',
    'token=secret-value',
    '账户 U6859001',
    '请卖出 10 股',
    '意见 <script>',
  ]) {
    const result = run(withDecisionState({
      decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
      receipts: [receipt({ publicSummary })],
    }));
    assert.notEqual(result.status, 0, publicSummary);
    assert.match(result.stderr, /publicSummary|external URL/);
  }
});

test('requires deferred decisions to remain awaiting_user', () => {
  const deferredReceipt = receipt({
    receiptId: 'R-20260830-154500-D4C3B2A1',
    action: 'deferred',
    publicSummary: '稍后决定；只记录，不执行',
  });
  const accepted = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [deferredReceipt],
  }));
  assert.equal(accepted.status, 0, accepted.stderr);

  const rejected = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [deferredReceipt],
  }));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /must remain awaiting_user/);
});

test('requires decision data attributes to match the template', () => {
  const statusMismatch = run(withDecisionState({
    markupOverrides: { 'D-20260829-GOOG-LIMIT': { status: 'accepted' } },
  }));
  assert.notEqual(statusMismatch.status, 0);
  assert.match(statusMismatch.stderr, /data attributes/);

  const idMismatch = run(withDecisionState({
    markupOverrides: { 'D-20260829-GOOG-LIMIT': { id: 'D-20260829-OTHER' } },
  }));
  assert.notEqual(idMismatch.status, 0);
  assert.match(idMismatch.stderr, /element id/);
});

test('requires the pending navigation badge to equal awaiting_user decisions', () => {
  const result = run(withDecisionState({ badge: 2 }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /navigation badge/);
});

test('continuity keeps legacy calls optional but prevents template rollback', () => {
  const legacy = run(valid(), '2026-08-25', {
    previousHtml: valid(), sourceSha, htmlBlob,
  });
  assert.equal(legacy.status, 0, legacy.stderr);

  const removed = run(valid(), '2026-08-25', {
    previousHtml: withDecisionState(), sourceSha, htmlBlob,
  });
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /cannot be removed after bootstrap/);

  const bootstrap = withDecisionState({
    decisions: [decision('D-20260829-BOOTSTRAP', 'awaiting_user')],
    receipts: [],
  });
  const acceptedBootstrap = run(bootstrap, '2026-08-25', {
    previousHtml: valid(), sourceSha, htmlBlob,
  });
  assert.equal(acceptedBootstrap.status, 0, acceptedBootstrap.stderr);

  const unsafeBootstrap = run(withDecisionState(), '2026-08-25', {
    previousHtml: valid(), sourceSha, htmlBlob,
  });
  assert.notEqual(unsafeBootstrap.status, 0);
  assert.match(unsafeBootstrap.stderr, /bootstrap must disable interaction and contain no receipts/);
});

test('continuity preserves prior decisions and receipts and binds new receipts to previous pair', () => {
  const previous = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const next = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const accepted = run(next, '2026-08-25', {
    previousHtml: previous, sourceSha, htmlBlob,
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  const wrongPair = run(next, '2026-08-25', {
    previousHtml: previous, sourceSha: 'c'.repeat(40), htmlBlob,
  });
  assert.notEqual(wrongPair.status, 0);
  assert.match(wrongPair.stderr, /trusted previous pair/);

  const removedDecision = run(withDecisionState({ decisions: [], receipts: [] }), '2026-08-25', {
    previousHtml: previous, sourceSha, htmlBlob,
  });
  assert.notEqual(removedDecision.status, 0);
  assert.match(removedDecision.stderr, /decision .* cannot be removed/);

  const missingReceipt = run(withDecisionState({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [],
  }), '2026-08-25', {
    previousHtml: previous, sourceSha, htmlBlob,
  });
  assert.notEqual(missingReceipt.status, 0);
  assert.match(missingReceipt.stderr, /must have a receipt|requires a matching new receipt/);
});

test('rejects a receipt for a newly introduced decision', () => {
  const previous = withDecisionState({
    interaction: 'enabled',
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const current = withDecisionState({
    interaction: 'enabled',
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'awaiting_user'),
      decision('D-20260830-NEW-DECISION', 'accepted'),
    ],
    receipts: [receipt({ decisionId: 'D-20260830-NEW-DECISION' })],
    recordsUpdate: true,
  });
  const result = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /decision ID order|trusted previous awaiting_user decision/);
});

test('rejects awaiting_user changing directly to rejected without a receipt action', () => {
  const previous = withDecisionState({
    interaction: 'enabled',
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const current = withDecisionState({
    interaction: 'enabled',
    decisions: [decision('D-20260829-MRVL-CLASS', 'rejected')],
    receipts: [],
  });
  const result = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid status transition/);
});

test('requires existing receipts to remain an immutable ordered prefix', () => {
  const first = receipt();
  const second = receipt({
    receiptId: 'R-20260830-154600-B2C3D4E5',
    decisionId: 'D-20260829-GOOG-LIMIT',
    recordedAtHkt: '2026-08-30T15:46:00+08:00',
  });
  const decisions = [
    decision('D-20260829-MRVL-CLASS', 'accepted'),
    decision('D-20260829-GOOG-LIMIT', 'accepted'),
  ];
  const previous = withDecisionState({ interaction: 'enabled', decisions, receipts: [first, second] });
  const reordered = withDecisionState({ interaction: 'enabled', decisions, receipts: [second, first] });
  const result = run(reordered, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable array prefix/);
});

test('accepts a cross-day records-update that changes only receipt machine state', () => {
  const previous = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const current = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const result = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.equal(result.status, 0, result.stderr);
});

test('records-update preserves interaction and permits only a marked resolved-card migration', () => {
  const previousDecisions = [
    decision('D-20260829-MRVL-CLASS', 'awaiting_user'),
    decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
  ];
  const previous = withDecisionDisplayGroups({ decisions: previousDecisions });
  const current = withDecisionDisplayGroups({
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'accepted'),
      decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
    ],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const accepted = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.equal(accepted.status, 0, accepted.stderr);

  const disabled = current.replace('"interaction":"enabled"', '"interaction":"disabled"');
  const downgrade = run(disabled, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.stderr, /preserve the trusted previous interaction mode/);
});

test('marked decision migration rejects wrong groups, count labels, and advice edits', () => {
  const previous = withDecisionDisplayGroups({
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'awaiting_user'),
      decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
    ],
  });
  const current = withDecisionDisplayGroups({
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'accepted'),
      decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
    ],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  for (const [changed, expected] of [
    [current.replace('1 项待 Wu 裁决', '2 项待 Wu 裁决'), /heading or count/],
    [current.replace('建议正文固定且不得修改', '建议正文被偷偷修改'), /changed content outside/],
    [current.replace(
      '<!-- xuan-ib-decision-group:v1:resolved:end -->',
      '<!-- xuan-ib-decision-group:v1:awaiting_user:end --><!-- xuan-ib-decision-group:v1:resolved:end -->'
    ), /marker|outside its required display group/],
  ]) {
    const result = run(changed, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test('guarded groups preserve existing superseded history while resolving another card', () => {
  const oldReceipt = receipt({
    receiptId: 'R-20260829-120000-AAAABBBB',
    action: 'accepted',
    recordedAtHkt: '2026-08-29T12:00:00+08:00',
  });
  const previous = withDecisionDisplayGroups({
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'superseded'),
      decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
    ],
    receipts: [oldReceipt],
  });
  const current = withDecisionDisplayGroups({
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'superseded'),
      decision('D-20260829-GOOG-LIMIT', 'accepted'),
    ],
    receipts: [oldReceipt, receipt({
      receiptId: 'R-20260830-154501-B1C2D3E4',
      decisionId: 'D-20260829-GOOG-LIMIT',
      recordedAtHkt: '2026-08-30T15:45:01+08:00',
    })],
    recordsUpdate: true,
  });
  const result = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.equal(result.status, 0, result.stderr);
});

test('migration normalization accepts the published mapping-card pending label variant', () => {
  let previous = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
  });
  previous = previous.replaceAll('待 Wu 审核', '待 Wu 审核 / 待仓库侧补全 mapping');
  const current = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const result = run(current, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.equal(result.status, 0, result.stderr);
});

test('records-update fails closed on edition, financial, as-of, or visible-body changes', () => {
  const previous = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const allowed = withDecisionDisplayGroups({
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  for (const changed of [
    allowed.replace('睡前版', '临时版'),
    allowed.replace('$1,000', '$9,999'),
    allowed.replace('as-of 2026-08-25 21:00 HKT', 'as-of 2026-08-26 08:00 HKT'),
    allowed.replace('计算 1+1=2', '计算 1+1=3'),
    allowed.replace('完整简报 ', '已迁移到结案区 '),
  ]) {
    const result = run(changed, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed content outside/);
  }
});

test('records-update marker is unique and requires a real appended receipt', () => {
  const untrusted = run(markRecordsUpdate(valid()));
  assert.notEqual(untrusted.status, 0);
  assert.match(untrusted.stderr, /requires a trusted previous/);

  const previous = withDecisionState({
    interaction: 'enabled',
    decisions: [decision('D-20260829-MRVL-CLASS', 'awaiting_user')],
    receipts: [],
  });
  const noReceipt = markRecordsUpdate(previous);
  const missing = run(noReceipt, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /append at least one/);

  const duplicateMarker = markRecordsUpdate(noReceipt);
  const duplicate = run(duplicateMarker, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /marker must be unique/);

  const unmarkedReceipt = withDecisionState({
    interaction: 'enabled',
    decisions: [decision('D-20260829-MRVL-CLASS', 'accepted')],
    receipts: [receipt()],
  });
  const unmarked = run(unmarkedReceipt, '2026-08-25', {
    previousHtml: previous, sourceSha, htmlBlob,
  });
  assert.notEqual(unmarked.status, 0);
  assert.match(unmarked.stderr, /require the records-update marker/);
});

test('records-update cannot reorder decisions or change an unrelated status', () => {
  const previousDecisions = [
    decision('D-20260829-MRVL-CLASS', 'awaiting_user'),
    decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
  ];
  const previous = withDecisionState({ interaction: 'enabled', decisions: previousDecisions, receipts: [] });
  const reordered = withDecisionState({
    interaction: 'enabled',
    decisions: [
      decision('D-20260829-GOOG-LIMIT', 'awaiting_user'),
      decision('D-20260829-MRVL-CLASS', 'accepted'),
    ],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const reorderResult = run(reordered, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(reorderResult.status, 0);
  assert.match(reorderResult.stderr, /decision ID order/);

  const unrelated = withDecisionState({
    interaction: 'enabled',
    decisions: [
      decision('D-20260829-MRVL-CLASS', 'accepted'),
      decision('D-20260829-GOOG-LIMIT', 'superseded'),
    ],
    receipts: [receipt()],
    recordsUpdate: true,
  });
  const unrelatedResult = run(unrelated, '2026-08-25', { previousHtml: previous, sourceSha, htmlBlob });
  assert.notEqual(unrelatedResult.status, 0);
  assert.match(unrelatedResult.stderr, /status change requires its matching receipt/);
});

test('workflows preserve prior dataDate only for fail-closed records-update candidates', () => {
  assert.match(validateWorkflow, /xuan-ib-records-update:v1/);
  assert.match(validateWorkflow, /data_date" != "\$previous_data_date/);
  assert.match(validateWorkflow, /Ordinary candidate data date is stale or in the future/);
  assert.match(promoteWorkflow, /xuan-ib-records-update:v1/);
  assert.match(promoteWorkflow, /data_date" != "\$source_data_date/);
  assert.match(promoteWorkflow, /data_date" != "\$today_hkt".*data_date" != "\$yesterday_hkt/);
});

test('continuity arguments are all-or-nothing', () => {
  const result = run(valid(), '2026-08-25', { sourceSha, htmlBlob });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires PREVIOUS_HTML/);
});
