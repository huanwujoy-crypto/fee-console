import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { correctCashPlan, CASH_CORRECTION_SOURCE_SHA, CASH_CORRECTION_SOURCE_BLOB, CASH_CORRECTION_NOTICE, updateCashPlanPresentation, CASH_PRESENTATION_SOURCE_SHA, CASH_PRESENTATION_SOURCE_BLOB, CASH_PRESENTATION_NOTICE, updateThreeWayCashPlan, CASH_THREE_WAY_SOURCE_SHA, CASH_THREE_WAY_SOURCE_BLOB, CASH_THREE_WAY_NOTICE } from './xuan-ib-cash-plan-correction.mjs';
import { classificationReportBlob } from './xuan-ib-classification-correction.mjs';
import { validateCashPlan } from './xuan-ib-cash-plan.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import { migratePolicyToEtfPane } from './xuan-ib-etf-pane.mjs';
import { renderClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';
const repo = fileURLToPath(new URL('..', import.meta.url));
const approvedPolicy = JSON.parse(fs.readFileSync(path.join(repo, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
const approvedPolicySection = renderPolicySection(approvedPolicy);
// Model a current ordinary report's disclosure and p3 -> p5 presentation.
// The exact historical repair outputs below stay untouched; this test-only
// migration is not an expanded production repair or fresh financial evidence.
const classificationBlock = /<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>/g;
const withMigratedEtfPolicyFixture = (html) => {
  const oldBlocks = [...html.matchAll(classificationBlock)];
  assert.equal(oldBlocks.length, 1, 'historical fixture has exactly one disclosure');
  const current = html.replace(oldBlocks[0][0], renderClassificationDisclosure());
  assert.equal(current.replace(renderClassificationDisclosure(), oldBlocks[0][0]), html,
    'synthetic disclosure migration changes no other bytes');
  return migratePolicyToEtfPane(current.replace(
    '<div class="pane p3">', '<div class="pane p3">' + approvedPolicySection
  ), approvedPolicy);
};
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
  fs.writeFileSync(previous, withMigratedEtfPolicyFixture(original)); fs.writeFileSync(current, withMigratedEtfPolicyFixture(corrected));
  const guard = path.join(repo, 'scripts/handover-guard.mjs');
  const env = { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: CASH_CORRECTION_SOURCE_SHA, XUAN_IB_PREVIOUS_HTML_BLOB: CASH_CORRECTION_SOURCE_BLOB };
  const oldDisclosure = [...corrected.matchAll(classificationBlock)][0][0];
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(corrected).replace(renderClassificationDisclosure(), oldDisclosure));
  const obsolete = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(obsolete.status, 0, 'unchanged historical disclosure must not pass the current gate');
  assert.match(obsolete.stderr + obsolete.stdout, /classification disclosure/);
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(corrected));
  const result = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(corrected.replace('$466,482', '$475,270')));
  const invalid = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /cash plan/);
});

test('trusted workflows copy and protect cash planning code alongside the guard', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/validate-xuan-ib-handover.yml'), 'utf8');
  assert.match(workflow, /git archive origin\/main --/);
  assert.match(workflow, /\n\s+scripts \\/);
  assert.match(workflow, /scripts\/xuan-ib-cash-plan\.mjs/);
  const lock = fs.readFileSync(path.join(repo, '.github/workflows/xuan-ib-policy-lock.yml'), 'utf8');
  assert.ok(lock.includes('xuan-ib-cash-plan|xuan-ib-cash-plan-correction'));
});

const presentationOriginal = execFileSync('git', ['show', 'd5517cb32cc189b04a6931ba2aa9cac54b04e263:xuan-ib/latest.html'], { cwd: repo, encoding: 'utf8' });
const presentationUpdated = updateCashPlanPresentation(presentationOriginal);
const stripCashDisplay = html => html
  .replace(/<div class="kpi" id="xuan-ib-cash-plan-kpi">[\s\S]*?<\/div><\/div>/, '')
  .replace(/<section class="card" id="xuan-ib-cash-plan-detail">[\s\S]*?<\/section>/, '')
  .replace(CASH_PRESENTATION_NOTICE, '');

test('ticker-first migration changes only two displays and one notice; all financial source and receipt bytes are retained', () => {
  assert.equal(classificationReportBlob(presentationOriginal), CASH_PRESENTATION_SOURCE_BLOB);
  for (const bad of [presentationOriginal + '\n', presentationUpdated, original, '', null]) assert.throws(() => updateCashPlanPresentation(bad), /exact approved source/);
  assert.equal(stripCashDisplay(presentationUpdated), stripCashDisplay(presentationOriginal));
  assert.equal(presentationUpdated.split(CASH_PRESENTATION_NOTICE).length, 2);
  assert.deepEqual(extract(presentationUpdated, /<!-- xuan-ib-cash-plan-v1:[A-Za-z0-9_-]+ -->/g), extract(presentationOriginal, /<!-- xuan-ib-cash-plan-v1:[A-Za-z0-9_-]+ -->/g));
  assert.deepEqual(validateCashPlan(presentationUpdated, { previousHtml: presentationOriginal }), []);
  for (const text of ['$584,291', '$466,482', '$117,809', '19.91%', '11.56%', '$251,903', '2026-08-31 16:48–16:55 HKT']) assert.ok(presentationUpdated.includes(text), text);
  assert.doesNotMatch(presentationUpdated, /xuan-ib-records-update:v1/);
});

test('ticker-first candidate passes trusted guard with original decisions and its CLI emits identical output', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-display-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = path.join(dir, 'previous.html'), current = path.join(dir, 'current.html');
  fs.writeFileSync(previous, withMigratedEtfPolicyFixture(presentationOriginal)); fs.writeFileSync(current, withMigratedEtfPolicyFixture(presentationUpdated));
  const env = { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: CASH_PRESENTATION_SOURCE_SHA, XUAN_IB_PREVIOUS_HTML_BLOB: CASH_PRESENTATION_SOURCE_BLOB };
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/handover-guard.mjs'), current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  fs.writeFileSync(previous, presentationOriginal);
  const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/xuan-ib-cash-plan-correction.mjs'), '--ticker-first', previous], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, presentationUpdated);
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(presentationUpdated.replace('USSC 待回款后重算', 'USSC 已有现金可立即买入')));
  const invalid = spawnSync(process.execPath, [path.join(repo, 'scripts/handover-guard.mjs'), current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /cash plan/);
});

const threeWayOriginal = execFileSync('git', ['show', '4a3795f61cf9cc307b118addbffe533d71ed7e24:xuan-ib/latest.html'], { cwd: repo, encoding: 'utf8' });
const readCashInput = html => JSON.parse(Buffer.from(html.match(/<!-- xuan-ib-cash-plan-v1:([A-Za-z0-9_-]+) -->/)[1], 'base64url').toString('utf8'));
const normalizeThreeWayScope = html => html
  .replace(/<div class="kpi" id="xuan-ib-cash-plan-kpi">[\s\S]*?<\/div><\/div>/, '')
  .replace(/<section class="card" id="xuan-ib-cash-plan-detail">[\s\S]*?<\/section>/, '')
  .replace(/<!-- xuan-ib-cash-plan-v1:[A-Za-z0-9_-]+ -->/, '')
  .replace(CASH_PRESENTATION_NOTICE, '').replace(CASH_THREE_WAY_NOTICE, '')
  .replace('EXUS + EIMI + USSC；USSC 参考占本次预算 10%，余款按联立模型分配', '非美发达 + 新兴市场（v9.6；USSC 走底仓换壳、不占用现金）')
  .replace('底仓内结构位 · 本次现金参考 10%；旧 14% 基数待核实，不用于本次测算', '底仓内结构位 · 走换壳、不占现金补仓池')
  .replace('四类分类及目标不变；USSC 参考占现金规划预算 10%，其余预算以含 USSC 买入后的股票分母重新联立计算 EXUS / EIMI，预算不足按完整补足额同比例缩减，仅为规划情景；45% 是美国底仓参考目标，不是新增硬上限', '四类分类及目标不变；现金补仓采用现金优先联立模型，股票分母随买入增加，预算不足按完整补足额同比例缩减，仅为规划情景');

test('three-way migration is source-bound, preserves all raw inputs and all bytes outside its explicit planning allowlist', () => {
  const updated = updateThreeWayCashPlan(threeWayOriginal);
  assert.equal(classificationReportBlob(threeWayOriginal), CASH_THREE_WAY_SOURCE_BLOB);
  for (const bad of [threeWayOriginal + '\n', updated, original, '', null]) assert.throws(() => updateThreeWayCashPlan(bad), /exact approved source/);
  const { schemaVersion, usBase, ussc, usscBudgetShare, ...raw } = readCashInput(updated);
  const { schemaVersion: previousSchema, ...previousRaw } = readCashInput(threeWayOriginal);
  assert.equal(previousSchema, 1); assert.equal(schemaVersion, 2);
  assert.deepEqual(raw, previousRaw);
  assert.equal(usBase, 1120091 + 510491 + 226960 + 15216 + 67520 + 65952);
  assert.equal(ussc, 15216); assert.equal(usscBudgetShare, .10);
  assert.equal(normalizeThreeWayScope(updated), normalizeThreeWayScope(threeWayOriginal));
  for (const regex of [/<table\b[^>]*>[\s\S]*?<\/table>/g, /<template\b[^>]*>[\s\S]*?<\/template>/g, /<details class="dcard"[\s\S]*?<\/details>/g, /<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/g, /<div class="foot">[\s\S]*?<\/div>/g, /<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>/g]) assert.deepEqual(extract(updated, regex), extract(threeWayOriginal, regex));
  assert.ok(updated.includes(CASH_THREE_WAY_NOTICE));
  assert.doesNotMatch(updated, /待回款后重算|不占(?:用现金|本次现金预算|现金补仓池)|USSC 走底仓换壳|xuan-ib-records-update:v1/);
  assert.deepEqual(validateCashPlan(updated, { previousHtml: threeWayOriginal }), []);
  for (const value of ['$584,291', '$417,141', '$108,721', '$58,429', '18.84%', '11.36%', '44.60%', '1.59%', '$341,794', '2026-08-31 16:48–16:55 HKT']) assert.ok(updated.includes(value), value);
});

test('three-way candidate passes full publication guard, CLI is deterministic, and tampering/downgrades fail', t => {
  const updated = updateThreeWayCashPlan(threeWayOriginal);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-three-way-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = path.join(dir, 'previous.html'), current = path.join(dir, 'current.html');
  fs.writeFileSync(previous, withMigratedEtfPolicyFixture(threeWayOriginal)); fs.writeFileSync(current, withMigratedEtfPolicyFixture(updated));
  const env = { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: CASH_THREE_WAY_SOURCE_SHA, XUAN_IB_PREVIOUS_HTML_BLOB: CASH_THREE_WAY_SOURCE_BLOB };
  const guard = path.join(repo, 'scripts/handover-guard.mjs');
  const result = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  fs.writeFileSync(previous, threeWayOriginal);
  const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/xuan-ib-cash-plan-correction.mjs'), '--three-way', previous], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, updated);
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(updated.replace('$58,429', '$158,429')));
  const invalid = spawnSync(process.execPath, [guard, current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /cash plan/);
  assert.ok(validateCashPlan(threeWayOriginal, { previousHtml: updated }).length, 'trusted v2 must not downgrade to old two-way plan');
});
