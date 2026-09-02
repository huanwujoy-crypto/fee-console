import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import {
  ETF_TAB_CSS_V1,
  ETF_TAB_LABEL_V1,
  ETF_TAB_RADIO_V1,
  migratePolicyToEtfPane,
} from './xuan-ib-etf-pane.mjs';

const policyPath = new URL('../claude/xuan-ib-policy-v2.json', import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const policyFile = fileURLToPath(policyPath);
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const script = fileURLToPath(new URL('./xuan-ib-etf-pane.mjs', import.meta.url));
const canonical = renderPolicySection(policy);

const exactPaneMarkup = (source, paneClass) => {
  const openings = [...source.matchAll(/<div\b[^>]*>/gi)];
  const opening = openings.find(match => new RegExp(`(?:^|\\s)${paneClass}(?:\\s|$)`).test(
    match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? '',
  ));
  if (!opening) throw new Error(`missing ${paneClass}`);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    depth += /^<\/div/i.test(match[0]) ? -1 : 1;
    if (depth === 0) return source.slice(opening.index, tags.lastIndex);
  }
  throw new Error(`unclosed ${paneClass}`);
};

const withoutMovedEtfNavigation = source => source
  .replace(ETF_TAB_RADIO_V1, '')
  .replace(ETF_TAB_LABEL_V1, '')
  .replace(exactPaneMarkup(source, 'p5'), '');

const legacyHandover = () => `<!doctype html><html><head><style>
.tabbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.pane{display:none}#s1:checked~.p1,#s2:checked~.p2,#s3:checked~.p3,#s4:checked~.p4{display:block}
</style></head><body><!-- xuan-ib-handover:v1 -->
<div class="tabs"><input type="radio" name="sec" id="s1" checked><input type="radio" name="sec" id="s2"><input type="radio" name="sec" id="s3"><input type="radio" name="sec" id="s4">
<div class="tabbar"><label for="s1">概览</label><label for="s2">风险</label><label for="s3">配置</label><label for="s4" aria-label="待办：0 项">待办</label></div>
<div class="pane p1">NAV $5,000,000</div><div class="pane p2">风险 20%</div><div class="pane p3">
<!-- canonical policy follows -->
${canonical}
<section id="operational-v1">现金计划 $584,489</section></div><div class="pane p4">待办 0</div></div>
</body></html>`;

test('ordinary migration creates an independent compact ETF tab without changing report facts', () => {
  const legacy = legacyHandover();
  const migrated = migratePolicyToEtfPane(legacy, policy);
  assert.equal(migratePolicyToEtfPane(migrated, policy), migrated, 'migration must be idempotent');
  assert.equal(migrated.split(canonical).length - 1, 1);
  assert.equal(migrated.split(ETF_TAB_CSS_V1).length - 1, 1);
  assert.equal(migrated.split(ETF_TAB_RADIO_V1).length - 1, 1);
  assert.equal(migrated.split(ETF_TAB_LABEL_V1).length - 1, 1);
  assert.ok(migrated.indexOf('id="s4"') < migrated.indexOf(ETF_TAB_RADIO_V1));
  assert.ok(migrated.indexOf('for="s4"') < migrated.indexOf(ETF_TAB_LABEL_V1));
  assert.match(migrated, /<div class="pane p3">\s*<!-- canonical policy follows -->\s*<section id="operational-v1">/);
  assert.match(migrated, /<div class="pane p5">\s*<section id="xuan-ib-policy-v2"/);
  assert.ok(migrated.indexOf('class="pane p3"') < migrated.indexOf('class="pane p4"'));
  assert.ok(migrated.indexOf('class="pane p4"') < migrated.indexOf('class="pane p5"'));
  for (const unchanged of ['NAV $5,000,000', '风险 20%', '现金计划 $584,489', '待办 0']) {
    assert.equal(migrated.split(unchanged).length - 1, 1, unchanged);
  }
  assert.match(ETF_TAB_CSS_V1, /repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(ETF_TAB_CSS_V1, /@media\(max-width:360px\)/);
  assert.match(ETF_TAB_CSS_V1, /font-size:11px/);
});

test('migration accepts the current checked-in production report and changes only the three moved ETF chunks', () => {
  const current = fs.readFileSync(path.join(repo, 'xuan-ib/latest.html'), 'utf8');
  const migrated = migratePolicyToEtfPane(current, policy);
  const financialTokens = source => source.match(/(?:[+-]?(?:C?\$|USD\s|CAD\s)[\d,]+(?:\.\d+)?(?:[MK])?|[+-]?\d+(?:\.\d+)?%)/g) ?? [];
  assert.deepEqual(financialTokens(migrated).sort(), financialTokens(current).sort());
  assert.equal(migrated.split(canonical).length - 1, 1);
  assert.match(migrated, /<div class="pane p5">\s*<section id="xuan-ib-policy-v2"/);
  assert.ok(migrated.indexOf('id="s4"') < migrated.indexOf(ETF_TAB_RADIO_V1));
  assert.ok(migrated.indexOf('for="s4"') < migrated.indexOf(ETF_TAB_LABEL_V1));
  assert.ok(migrated.indexOf('class="pane p4"') < migrated.indexOf('class="pane p5"'));
  assert.equal(exactPaneMarkup(migrated, 'p5'), exactPaneMarkup(current, 'p5'));
  assert.equal(withoutMovedEtfNavigation(migrated), withoutMovedEtfNavigation(current));
  assert.equal(migratePolicyToEtfPane(migrated, policy), migrated);
});

test('migration fails closed on records updates, partial UI and noncanonical placement', () => {
  const legacy = legacyHandover();
  for (const changed of [
    legacy.replace('<!-- xuan-ib-handover:v1 -->', '<!-- xuan-ib-handover:v1 --><!-- xuan-ib-records-update:v1 -->'),
    legacy.replace('<label for="s4"', ETF_TAB_LABEL_V1 + '<label for="s4"'),
    legacy.replace('<label for="s4"', '<label for=s5>partial</label><label for="s4"'),
    legacy.replace('<input type="radio" name="sec" id="s4">', '<input id=s5><input type="radio" name="sec" id="s4">'),
    legacy.replace('<label for="s4"', '<label for="s&#53;">partial</label><label for="s4"'),
    legacy.replace('<input type="radio" name="sec" id="s4">', '<input id="s&#53;"><input type="radio" name="sec" id="s4">'),
    legacy.replace('<div class="pane p3">\n<!-- canonical policy follows -->\n', '<div class="pane p3"><p>other module</p>'),
    legacy.replace(canonical, canonical.replace('已批准 · 建基线中', '已执行')),
    legacy.replace('<input type="radio" name="sec" id="s4">', ''),
    legacy.replace('<style>', '<style media="not all">'),
  ]) assert.throws(() => migratePolicyToEtfPane(changed, policy));
});

test('integrated migration rejects unquoted duplicates and unreachable navigation', () => {
  const migrated = migratePolicyToEtfPane(legacyHandover(), policy);
  for (const changed of [
    migrated.replace(ETF_TAB_RADIO_V1, `${ETF_TAB_RADIO_V1}<input id=s5>`),
    migrated.replace(ETF_TAB_LABEL_V1, `${ETF_TAB_LABEL_V1}<label for=s5>duplicate</label>`),
    migrated.replace(ETF_TAB_RADIO_V1, `${ETF_TAB_RADIO_V1}<input id="s&#53;">`),
    migrated.replace(ETF_TAB_LABEL_V1, `${ETF_TAB_LABEL_V1}<label for="s&#53;">duplicate</label>`),
    migrated.replace(ETF_TAB_RADIO_V1, '<input type="radio" name="sec" id="s5" disabled>'),
    migrated.replace(
      `<input type="radio" name="sec" id="s4">${ETF_TAB_RADIO_V1}`,
      `${ETF_TAB_RADIO_V1}<input type="radio" name="sec" id="s4">`
    ),
    migrated.replace(
      `<label for="s4" aria-label="待办：0 项">待办</label>\n${ETF_TAB_LABEL_V1}`,
      `${ETF_TAB_LABEL_V1}\n<label for="s4" aria-label="待办：0 项">待办</label>`
    ),
    migrated.replace('<label for="s2">风险</label>', '<label for="s2">配置</label>'),
    migrated.replace(ETF_TAB_LABEL_V1, '').replace(
      '<div class="pane p1">',
      `${ETF_TAB_LABEL_V1}<div class="pane p1">`
    ),
    migrated.replace(ETF_TAB_RADIO_V1, '').replace(
      '<div class="pane p1">',
      `${ETF_TAB_RADIO_V1}<div class="pane p1">`
    ),
    migrated.replace('<style>', '<style media="not all">'),
    migrated.replace(`\n${ETF_TAB_CSS_V1}\n`, '').replace(
      '<div class="tabs">',
      `<style>${ETF_TAB_CSS_V1}</style><div class="tabs">`
    ),
  ]) assert.throws(() => migratePolicyToEtfPane(changed, policy));
});

test('migration CLI emits the same byte-exact candidate as the pure function', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-pane-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const input = path.join(dir, 'handover.html');
  fs.writeFileSync(input, legacyHandover());
  const result = spawnSync(process.execPath, [script, input, policyFile], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, migratePolicyToEtfPane(legacyHandover(), policy));
});

test('trusted validation, test suite, policy lock and owner review cover the migration helper', () => {
  const validateWorkflow = fs.readFileSync(path.join(repo, '.github/workflows/validate-xuan-ib-handover.yml'), 'utf8');
  const scriptsWorkflow = fs.readFileSync(path.join(repo, '.github/workflows/scripts-check.yml'), 'utf8');
  const policyLock = fs.readFileSync(path.join(repo, '.github/workflows/xuan-ib-policy-lock.yml'), 'utf8');
  const codeowners = fs.readFileSync(path.join(repo, '.github/CODEOWNERS'), 'utf8');
  assert.match(validateWorkflow, /git archive origin\/main -- scripts \| tar -x -C "\$trusted_root"/);
  assert.match(validateWorkflow, /scripts\/xuan-ib-etf-pane\.mjs/);
  assert.match(validateWorkflow, /scripts\/xuan-ib-etf-abc\.mjs/);
  assert.match(scriptsWorkflow, /scripts\/xuan-ib-etf-pane\.test\.mjs/);
  assert.match(scriptsWorkflow, /scripts\/xuan-ib-etf-abc\.test\.mjs/);
  assert.match(policyLock, /xuan-ib-etf-pane/);
  assert.match(policyLock, /xuan-ib-etf-abc-v1/);
  assert.match(policyLock, /xuan-ib-etf-abc/);
  assert.match(codeowners, /\/claude\/xuan-ib-etf-abc-v1\.md @huanwujoy-crypto/);
  assert.match(codeowners, /\/scripts\/xuan-ib-etf-pane\.mjs @huanwujoy-crypto/);
  assert.match(codeowners, /\/scripts\/xuan-ib-etf-pane\.test\.mjs @huanwujoy-crypto/);
  assert.match(codeowners, /\/scripts\/xuan-ib-etf-abc\.mjs @huanwujoy-crypto/);
  assert.match(codeowners, /\/scripts\/xuan-ib-etf-abc\.test\.mjs @huanwujoy-crypto/);
});
