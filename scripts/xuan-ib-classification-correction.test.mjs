import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CLASSIFICATION_CORRECTION_NOTICE,
  CLASSIFICATION_CORRECTION_SOURCE_BLOB,
  CLASSIFICATION_CORRECTION_SOURCE_SHA,
  classificationReportBlob,
  correctClassificationExplanation,
  verifyClassificationCorrection,
} from './xuan-ib-classification-correction.mjs';
import { renderClassificationDisclosure, validateClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('./xuan-ib-classification-correction.mjs', import.meta.url));
const guard = fileURLToPath(new URL('./handover-guard.mjs', import.meta.url));
// Main's immutable published ancestor is available in the required full-history
// scripts-check checkout. Never silently switch this fixture to a later report.
const fixture = spawnSync('git', ['show', 'a64f78c55f2b51008de30ae914fa173e8770f61d:xuan-ib/latest.html'], {
  cwd: repo, encoding: 'utf8', maxBuffer: 2_000_000,
});
assert.equal(fixture.status, 0, 'Correction regression requires main history (fetch-depth: 0): ' + fixture.stderr);
const original = fixture.stdout;
const corrected = correctClassificationExplanation(original);
const finance = html => html.match(/(?:[+-]?(?:C?\$|USD\s|CAD\s)[\d,]+(?:\.\d+)?(?:[MK])?|[+-]?\d+(?:\.\d+)?%)/g) ?? [];
const template = html => html.match(/<template id="xuan-ib-decision-state-v1"[^>]*>[\s\S]*?<\/template>/)?.[0];
const extract = (html, pattern) => [...html.matchAll(pattern)].map(match => match[0]);

function temporaryReport(t, html, name = 'report.html') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-classification-correction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return { dir, file };
}

test('one-shot repair is bound to the exact published report', () => {
  assert.equal(classificationReportBlob(original), CLASSIFICATION_CORRECTION_SOURCE_BLOB);
  assert.match(original, /精确计数仍为 56 个/);
  assert.match(original, /其余 48 个/);
  assert.notEqual(classificationReportBlob(corrected), CLASSIFICATION_CORRECTION_SOURCE_BLOB);
  assert.equal(correctClassificationExplanation(original), corrected);
  for (const changed of [original + '\n', original.replace('$5,033,559', '$5,033,560'), corrected, '', null]) {
    assert.throws(() => correctClassificationExplanation(changed), /exact approved historical report blob/);
  }
});

test('all currency and percentage tokens remain byte-identical and in original order', () => {
  assert.ok(finance(original).length > 200);
  assert.deepEqual(finance(corrected), finance(original));
  assert.deepEqual(extract(corrected, /<table\b[^>]*>[\s\S]*?<\/table>/g), extract(original, /<table\b[^>]*>[\s\S]*?<\/table>/g));
  const beforeKpis = original.match(/<div class="kpis">[\s\S]*?(?=<div class="tabs">)/)?.[0];
  const afterKpis = corrected.match(/<div class="kpis">[\s\S]*?(?=<div class="tabs">)/)?.[0];
  assert.equal(afterKpis, beforeKpis.replace('沿用 08-24 · mapping 已核实仍缺 override', '沿用 08-24 · 完整核验仍待完成'));
});

test('original header, data time, edition, footer and all unrelated decision cards are preserved', () => {
  for (const pattern of [
    /<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/g,
    /<div class="foot">[\s\S]*?<\/div>/g,
    /<li><b>版次与时点。<\/b>[\s\S]*?<\/li>/g,
    /<details class="dcard" id="D-20260829-(?:MRVL-CLASS|GOOG-FAMILY-LIMIT)"[\s\S]*?<\/details>/g,
  ]) {
    const before = extract(original, pattern);
    assert.ok(before.length, pattern.source);
    assert.deepEqual(extract(corrected, pattern), before);
  }
  assert.ok(corrected.includes(CLASSIFICATION_CORRECTION_NOTICE));
  assert.doesNotMatch(corrected, /xuan-ib-records-update:v1/);
});

test('decision state and three original signed-publication-bound receipts are untouched', () => {
  assert.equal(template(corrected), template(original));
  const state = JSON.parse(template(corrected).replace(/^[\s\S]*?>/, '').replace(/<\/template>$/, ''));
  assert.equal(state.decisions.length, 3);
  assert.equal(state.receipts.length, 3);
  assert.ok(state.decisions.every(decision => decision.status === 'accepted'));
  assert.deepEqual(state.receipts.map(receipt => receipt.receiptId), [
    'R-20260831-064906-7F3K9QXM', 'R-20260831-064907-2LM4P8YB', 'R-20260831-064908-9RT6WZ2N',
  ]);
  assert.ok(state.receipts.every(receipt => receipt.responseToSourceSha === '3769a3e05e954474573b6b1e247374f4e2addfb5'
    && receipt.responseToHtmlBlob === '0c64cbfcc39c43d13c4ed1cb46b398d3ce26091b'));
});

test('all obsolete current coverage claims are replaced, with one folded canonical explanation', () => {
  assert.match(corrected, /3 · 四桶分类核验与数据完整性复核/);
  assert.match(corrected, /下一步先核实现金身份及剩余组合的数据完整性/);
  assert.doesNotMatch(corrected, /精确计数仍为 56 个|其余 48 个|补全约 48|仍缺多数 Semi Liquid|仍缺 override/);
  assert.equal(corrected.split(renderClassificationDisclosure()).length, 2);
  assert.match(corrected, /<details><summary>报告说明[\s\S]*?<\/ol>\s*<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>\s*<\/div><\/details>/);
  assert.deepEqual(validateClassificationDisclosure(corrected, { previousHtml: original }), []);
  assert.ok(validateClassificationDisclosure(original, { previousHtml: original }).length);
});

test('verification rejects arbitrary extra edits even if their numbers look unchanged', () => {
  const result = verifyClassificationCorrection(original, corrected);
  assert.equal(result.sourceSha, CLASSIFICATION_CORRECTION_SOURCE_SHA);
  assert.equal(result.correctedHtmlBlob, classificationReportBlob(corrected));
  assert.equal(result.readNewFinancialData, false);
  assert.equal(result.recalculatedAmounts, false);
  for (const changed of [corrected + '\n', corrected.replace('只读报告', '可交易报告'), corrected.replace('$5,033,559', '$5,033,560')]) {
    assert.throws(() => verifyClassificationCorrection(original, changed), /differs from the deterministic/);
  }
});

test('trusted publication guard rejects obsolete report and accepts exact explanation-only repair', t => {
  const previous = temporaryReport(t, original, 'previous.html');
  const current = temporaryReport(t, corrected);
  const env = {
    ...process.env,
    XUAN_IB_PREVIOUS_SOURCE_SHA: CLASSIFICATION_CORRECTION_SOURCE_SHA,
    XUAN_IB_PREVIOUS_HTML_BLOB: CLASSIFICATION_CORRECTION_SOURCE_BLOB,
  };
  const rejected = spawnSync(process.execPath, [guard, previous.file, '2026-08-31', previous.file], { env, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr + rejected.stdout, /classification disclosure/);
  const accepted = spawnSync(process.execPath, [guard, current.file, '2026-08-31', previous.file], { env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
});

test('CLI emits only corrected HTML or a concise invariant result and never writes a report', t => {
  const source = temporaryReport(t, original);
  const htmlRun = spawnSync(process.execPath, [script, source.file], { encoding: 'utf8', maxBuffer: 2_000_000 });
  assert.equal(htmlRun.status, 0, htmlRun.stderr);
  assert.equal(htmlRun.stdout, corrected);
  const verifyRun = spawnSync(process.execPath, [script, '--verify', source.file], { encoding: 'utf8' });
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
  assert.deepEqual(JSON.parse(verifyRun.stdout), verifyClassificationCorrection(original, corrected));
  assert.equal(fs.readFileSync(source.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(source.dir), ['report.html']);
  const invalid = spawnSync(process.execPath, [script, '--replace-current'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
});
