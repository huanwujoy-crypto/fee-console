import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { correctCashPlan, CASH_CORRECTION_SOURCE_SHA, CASH_CORRECTION_SOURCE_BLOB, CASH_CORRECTION_NOTICE } from './xuan-ib-cash-plan-correction.mjs';
import { classificationReportBlob } from './xuan-ib-classification-correction.mjs';
import { validateCashPlan } from './xuan-ib-cash-plan.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
const original = execFileSync('git', ['show', '258f98fe59c28b745908d43f998dbc144662dc1b:xuan-ib/latest.html'], { cwd: repo, encoding: 'utf8' });
const corrected = correctCashPlan(original);
const extract = (html, regex) => [...html.matchAll(regex)].map(m => m[0]);

test('cash correction is exact-source-bound and preserves accounts, source tables, receipts and dates', () => {
  assert.equal(classificationReportBlob(original), CASH_CORRECTION_SOURCE_BLOB);
  for (const bad of [original + '\n', corrected, '', null]) assert.throws(() => correctCashPlan(bad), /exact approved source/);
  for (const regex of [/<table\b[^>]*>[\s\S]*?<\/table>/g, /<template\b[^>]*>[\s\S]*?<\/template>/g, /<details class="dcard"[\s\S]*?<\/details>/g, /<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/g, /<div class="foot">[\s\S]*?<\/div>/g, /<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>/g]) assert.deepEqual(extract(corrected, regex), extract(original, regex));
  assert.ok(corrected.includes(CASH_CORRECTION_NOTICE));
  assert.equal(extract(corrected, /<template\b/g).length, 1);
  assert.deepEqual(validateCashPlan(corrected, { previousHtml: original }), []);
  assert.doesNotMatch(corrected, /107\.50%|动态缺口（纯新钱补入）|四类 · 补仓缺口合计/);
  assert.match(corrected, /<details><summary>超配观察[\s\S]*?美国底仓[\s\S]*?美国科技[\s\S]*?<\/details>/);
});

test('cash correction passes the entire trusted publication guard with original decision continuity', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-plan-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = path.join(dir, 'previous.html'), current = path.join(dir, 'current.html');
  fs.writeFileSync(previous, original); fs.writeFileSync(current, corrected);
  const guard = path.join(repo, 'scripts/handover-guard.mjs');
  const env = { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: CASH_CORRECTION_SOURCE_SHA, XUAN_IB_PREVIOUS_HTML_BLOB: CASH_CORRECTION_SOURCE_BLOB };
  const result = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  fs.writeFileSync(current, corrected.replace('$466,482', '$475,270'));
  const invalid = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /cash plan/);
});

test('trusted workflows copy and protect cash planning code alongside the guard', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/validate-xuan-ib-handover.yml'), 'utf8');
  assert.match(workflow, /git show origin\/main:scripts\/xuan-ib-cash-plan\.mjs > "\$RUNNER_TEMP\/xuan-ib-cash-plan\.mjs"/);
  const lock = fs.readFileSync(path.join(repo, '.github/workflows/xuan-ib-policy-lock.yml'), 'utf8');
  assert.ok(lock.includes('xuan-ib-cash-plan|xuan-ib-cash-plan-correction'));
});
