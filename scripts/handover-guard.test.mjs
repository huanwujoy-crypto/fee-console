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
<html><head><title>XUAN-IB 睡前交接</title><style>body{color:#111}</style></head>
<body><!-- xuan-ib-handover:v1 --><h1>2026-08-25</h1><p>${'完整简报 '.repeat(180)}</p>${extra}</body></html>
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

test('rejects the wrong data date', () => {
  const result = run(valid(), '2026-08-24');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /date is not present/);
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
