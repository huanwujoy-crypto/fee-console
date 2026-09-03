import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calculateMrvlT1, calculateMrvlT1Snapshot, updateMrvlT1Report, validateMrvlT1Policy, loadMrvlT1Policy,
  MRVL_T1_SOURCE_SHA, MRVL_T1_SOURCE_BLOB, MRVL_T1_IDENTITY, MRVL_T1_SNAPSHOT_NOTICE } from './xuan-ib-mrvl-t1.mjs';
import { classificationReportBlob } from './xuan-ib-classification-correction.mjs';
import { validateCashPlan } from './xuan-ib-cash-plan.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import { migratePolicyToEtfPane } from './xuan-ib-etf-pane.mjs';
import { renderClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const approvedPolicy = JSON.parse(fs.readFileSync(path.join(repo, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
const approvedPolicySection = renderPolicySection(approvedPolicy);
// Preserve the exact historical repair output while modelling a current
// ordinary report's trusted disclosure and independent p5 presentation.
// This test-only migration neither changes the repair binding nor reads data.
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
const fixtureCommit = 'fc27cd8aaadfda0be42d0c5114ca4066d5fad499';
const original = execFileSync('git', ['show', fixtureCommit + ':xuan-ib/latest.html'], { cwd: repo, encoding: 'utf8' });
const meta = JSON.parse(execFileSync('git', ['show', fixtureCommit + ':xuan-ib/latest.meta.json'], { cwd: repo, encoding: 'utf8' }));
const binding = { sourceSha: MRVL_T1_SOURCE_SHA, htmlBlob: MRVL_T1_SOURCE_BLOB };
const holding = { ...MRVL_T1_IDENTITY, currency: 'USD', marketValue: 21662 };
const policy = loadMrvlT1Policy();
const updated = updateMrvlT1Report(original, binding);
const extract = (html, regex) => [...html.matchAll(regex)].map(m => m[0]);
const aiPattern = /<details><summary>AI 压力敞口[\s\S]*?(?=<details><summary>单票集中度)/g;

test('fresh MRVL calculation uses only the approved exact identity and standard T1 coefficients', () => {
  assert.deepEqual(calculateMrvlT1(holding), { ...MRVL_T1_IDENTITY, currency: 'USD', marketValue: 21662, tier: 'T1', approvalId: 'WU-20260831-MRVL-T1', low: 12997.2, mid: 17329.6, high: 21662 });
  assert.equal(calculateMrvlT1({ ...holding, marketValue: .01 }).low, .006);
  assert.equal(calculateMrvlT1({ ...holding, marketValue: 20000 }).mid, 16000);
  assert.equal(calculateMrvlT1({ ...holding, marketValue: 0 }).mid, 0);
  for (const value of [undefined, null, '21662', -1, Infinity, NaN, .001, 1e13]) {
    assert.throws(() => calculateMrvlT1({ ...holding, marketValue: value }), /marketValue/);
  }
  for (const field of ['symbol', 'portfolioId', 'holdingId', 'currency']) {
    assert.throws(() => calculateMrvlT1({ ...holding, [field]: 'unknown' }), /unapproved|currency/);
    const missing = { ...holding }; delete missing[field];
    assert.throws(() => calculateMrvlT1(missing), /fields/);
  }
  assert.throws(() => calculateMrvlT1({ ...holding, tier: 'T1' }), /unknown fields/);
});

test('persisted policy cannot silently expand approval, change identity, substitute coefficients or accept unknown fields', () => {
  assert.equal(validateMrvlT1Policy(policy).mid, .8);
  for (const [key, value] of Object.entries({ symbol: 'AVGO', portfolioId: '936247', holdingId: 'other', tier: 'T2', low: .5, mid: .55, high: .7, approvalId: 'other' })) {
    const bad = structuredClone(policy); bad.overrides[0][key] = value;
    assert.throws(() => validateMrvlT1Policy(bad), /unapproved/);
    assert.throws(() => calculateMrvlT1(holding, bad), /unapproved/);
  }
  for (const bad of [null, {}, { ...policy, schemaVersion: 2 }, { ...policy, purpose: 'trading' },
    { ...policy, effectiveFromHkt: 'today' }, { ...policy, overrides: [] },
    { ...policy, overrides: [...policy.overrides, policy.overrides[0]] }, { ...policy, defaultTier: 'T1' }]) {
    assert.throws(() => validateMrvlT1Policy(bad));
  }
  const extra = structuredClone(policy); extra.overrides[0].unknown = true;
  assert.throws(() => validateMrvlT1Policy(extra), /unknown fields/);
});

test('one-time correction binds both immutable SHA and actual report bytes, never a fresh report or guessed source', () => {
  assert.equal(meta.sourceSha, binding.sourceSha); assert.equal(meta.htmlBlob, binding.htmlBlob);
  assert.equal(classificationReportBlob(original), binding.htmlBlob);
  for (const bad of [null, '', original + '\n', updated, original.replace('21,662', '21,663')]) assert.throws(() => updateMrvlT1Report(bad, binding), /exact approved source/);
  for (const bad of [undefined, {}, { ...binding, sourceSha: '0'.repeat(40) }, { ...binding, htmlBlob: '0'.repeat(40) }, { ...binding, trusted: true }]) assert.throws(() => updateMrvlT1Report(original, bad), /binding|exact approved source/);
});

test('middle scenario sums unrounded line products and corrects MSFT rounding with exact account totals', () => {
  const result = calculateMrvlT1Snapshot(original, binding);
  assert.deepEqual(result.accounts.map(account => account.amount), [1118483.8217, 201687.95, 73451.55]);
  assert.deepEqual(result.accounts.map(account => account.count), [19, 7, 3]);
  assert.equal(result.mid, 1393623.3217); assert.equal(result.denominator, 6141014); assert.equal(result.midPct, '22.69');
  assert.equal(result.contributions.find(row => row.symbol === 'MSFT').amount, 2800.6);
  assert.match(updated, /MSFT<\/span>[\s\S]*?<td>5,092<\/td><td>55\.00%<\/td><td>2,801<\/td>/);
  const ai = extract(updated, aiPattern)[0];
  for (const value of ['1,118,484', '201,688', '73,452', '1,393,623', '22.69%', '$141,630 / 2.31', '$448,681 / 7.31', '+$165,421 / +2.69']) assert.ok(ai.includes(value), value);
  assert.ok(ai.includes('合计不使用已舍入行值'));
  assert.ok(ai.includes('显示项相加与合计可差 $1'));
  assert.notEqual(result.accounts.reduce((sum, account) => sum + Math.round(account.amount), 0), Math.round(result.mid));
});

test('AI table preserves every original market value and all non-MRVL coefficients; visible status does not claim still pending', () => {
  const readRows = html => [...extract(html, aiPattern)[0].matchAll(/<tr><td><span class="sym">([^<]+)<\/span>[\s\S]*?<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)]
    .map(match => ({ symbol: match[1], marketValue: match[2], coefficient: match[3] }));
  const before = readRows(original), after = readRows(updated);
  assert.equal(before.length, 29); assert.equal(after.length, 29);
  assert.deepEqual(after, before.map(row => row.symbol === 'MRVL' ? { ...row, coefficient: '80.00%' } : row));
  const mrvlCard = updated.match(/<details class="dcard" id="D-20260829-MRVL-CLASS"[\s\S]*?<\/details>/)[0];
  assert.ok(mrvlCard.includes('已决定 / 本期风险计算已更新'));
  assert.doesNotMatch(mrvlCard, /待落实|未分类新标的/);
  for (const label of ['三级状态（中情景）', '距 25% 预警线（中情景）', '距 30% 最高警报线（中情景）']) assert.ok(updated.includes(label));
});

test('low/high retain original approximate bases and add only exact MRVL increments; no fabricated full three-tier claim', () => {
  const result = calculateMrvlT1Snapshot(original, binding);
  assert.equal(result.lowApprox, 977091.2); assert.equal(result.highApprox, 1799833);
  const ai = extract(updated, aiPattern)[0];
  for (const value of ['非完整逐票三档重算', '$964,094 / $1,778,171', '$12,997.20 / $21,662.00', '≈$977,091', '15.91%', '≈$1,799,833', '29.31%', '不可据此精确判断高情景是否越过警戒线']) assert.ok(ai.includes(value), value);
  assert.doesNotMatch(ai, /MRVL 若计入|不含 MRVL|MRVL.*未核实|0\.7005|1\.292/);
});

test('all original non-AI financial tables, other cards, cash-plan, classification, headers and original three receipts remain byte-identical', () => {
  const withoutAi = html => html.replace(aiPattern, '');
  for (const regex of [/<table\b[^>]*>[\s\S]*?<\/table>/g, /<template\b[^>]*>[\s\S]*?<\/template>/g,
    /<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/g, /<div class="foot">[\s\S]*?<\/div>/g,
    /<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>/g,
    /<div class="kpi" id="xuan-ib-cash-plan-kpi">[\s\S]*?<\/div><\/div>/g,
    /<section class="card" id="xuan-ib-cash-plan-detail">[\s\S]*?<\/section>/g,
    /<!-- xuan-ib-cash-plan-v1:[A-Za-z0-9_-]+ -->/g]) {
    const before = extract(withoutAi(original), regex); assert.ok(before.length, regex.source);
    assert.deepEqual(extract(withoutAi(updated), regex), before, regex.source);
  }
  const otherCards = html => extract(html, /<details class="dcard"[\s\S]*?<\/details>/g).filter(card => !card.includes('id="D-20260829-MRVL-CLASS"'));
  assert.deepEqual(otherCards(updated), otherCards(original));
  const state = JSON.parse(original.match(/<template id="xuan-ib-decision-state-v1"[^>]*>([\s\S]*?)<\/template>/)[1]);
  assert.equal(state.receipts.length, 3);
  assert.deepEqual(validateCashPlan(updated, { previousHtml: original }), []);
  assert.doesNotMatch(updated, /xuan-ib-records-update:v1/);
  assert.ok(updated.includes(MRVL_T1_SNAPSHOT_NOTICE));
  assert.match(updated, /<details id="xuan-ib-mrvl-t1-snapshot-update"><summary>/);
  assert.doesNotMatch(updated, /§0-A 未核实，不计入分子|MRVL 待决定事项沿用未决|MRVL .*未分类新标的/);
});

test('every byte outside the four explicit approved AI presentation areas is unchanged', () => {
  const normalize = html => html.replace(aiPattern, '')
    .replace(/<li><b>AI 压力中情景[\s\S]*?<\/li>/g, '')
    .replace(/<details class="dcard" id="D-20260829-MRVL-CLASS"[\s\S]*?<\/details>/g, '')
    .replace(/AI 压力 T1\/T2\/T3 阶梯与 ETF 穿透权重逐票沿用（未发明新系数）|AI 压力除 MRVL 按新批准标准 T1 60% \/ 80% \/ 100% 纳入外，其余 T1\/T2\/T3 阶梯与 ETF 穿透权重沿用；中情景按原快照表内输入未舍入汇总，低 \/ 高仅为原组合近似基数加 MRVL 增量/, '__METHOD__')
    .replace(/MRVL 待决定事项沿用未决（§0-A 规则本次仍未核实）。|MRVL 普通资产分类与 §0-C AI 压力分类分开；本次按用户新批准标准 T1 纳入风险测算，原 3 条回执保持历史原文，不代表交易授权。/, '__MRVL__');
  assert.equal(normalize(updated), normalize(original));
});

test('trusted publication guard accepts the candidate and explicit-binding CLI emits identical HTML without changing its input', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrvl-t1-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = path.join(dir, 'previous.html'), current = path.join(dir, 'current.html');
  fs.writeFileSync(previous, withMigratedEtfPolicyFixture(original)); fs.writeFileSync(current, withMigratedEtfPolicyFixture(updated));
  const env = { ...process.env, XUAN_IB_PREVIOUS_SOURCE_SHA: binding.sourceSha, XUAN_IB_PREVIOUS_HTML_BLOB: binding.htmlBlob };
  const oldDisclosure = [...updated.matchAll(classificationBlock)][0][0];
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(updated).replace(renderClassificationDisclosure(), oldDisclosure));
  const obsolete = spawnSync(process.execPath, [path.join(repo, 'scripts/handover-guard.mjs'), current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.notEqual(obsolete.status, 0, 'unchanged historical disclosure must not pass the current gate');
  assert.match(obsolete.stderr + obsolete.stdout, /classification disclosure/);
  fs.writeFileSync(current, withMigratedEtfPolicyFixture(updated));
  const guard = spawnSync(process.execPath, [path.join(repo, 'scripts/handover-guard.mjs'), current, '2026-08-31', previous], { env, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stderr + guard.stdout);
  fs.writeFileSync(previous, original);
  const script = path.join(repo, 'scripts/xuan-ib-mrvl-t1.mjs');
  const cli = spawnSync(process.execPath, [script, previous, '--source-sha', binding.sourceSha, '--html-blob', binding.htmlBlob], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, updated); assert.equal(fs.readFileSync(previous, 'utf8'), original);
  const missing = spawnSync(process.execPath, [script, previous], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Usage/); assert.equal(missing.stdout, '');
  const wrong = spawnSync(process.execPath, [script, current, '--source-sha', binding.sourceSha, '--html-blob', binding.htmlBlob], { encoding: 'utf8' });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /exact approved source/); assert.equal(wrong.stdout, '');
});
