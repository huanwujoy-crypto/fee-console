import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, 'handover-guard.mjs');

const valid = (extra = '') => `<!doctype html>
<html><head><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN-投资管理</title><style>body{color:#111}</style></head>
<body><!-- xuan-ib-handover:v1 --><h1>XUAN-投资管理</h1><span class="date">2026-08-25 周二 · 21:00 HKT</span><p>${'完整简报 '.repeat(180)}</p>${extra}</body></html>
`;

const run = (html, date = '2026-08-25') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-guard-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return spawnSync(process.execPath, [guard, file, date], {
    encoding: 'utf8',
  });
};

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
