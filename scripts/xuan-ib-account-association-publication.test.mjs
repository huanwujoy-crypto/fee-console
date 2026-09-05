import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  associationPolicyBlob, createAssociationReceipt, renderAssociationReceipt, renderAssociationDisclosure,
} from './xuan-ib-account-association.mjs';
import {
  ASSOCIATION_BODY_ATTRIBUTE, checkAssociationPublication, publicationEdition,
} from './xuan-ib-account-association-publication.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import { ETF_TAB_CSS_V1, ETF_TAB_LABEL_V1, ETF_TAB_RADIO_V1 } from './xuan-ib-etf-pane.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const inactive = JSON.parse(fs.readFileSync(path.join(repo, 'claude/xuan-ib-account-association-v1.json'), 'utf8'));
const fixedNow = Date.parse('2026-09-05T10:00:00.000Z');
const sourceSha = 'a'.repeat(40), runId = 'b'.repeat(64);
function snapshot(now = fixedNow, status = 'active') {
  const policy = { ...inactive, status, ...(status === 'inactive' ? {} : {
    validFrom: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
  }) };
  return { policy, policyCommit: 'c'.repeat(40), policyBlob: associationPolicyBlob(policy), checkedAt: new Date(now).toISOString() };
}
function fixture(now = fixedNow) {
  const current = snapshot(now);
  const receipt = createAssociationReceipt(current, { now, previousSourceSha: sourceSha, runId });
  const disclosure = renderAssociationDisclosure(receipt, current);
  const template = renderAssociationReceipt(receipt);
  const html = `<html><body ${ASSOCIATION_BODY_ATTRIBUTE}><span class="date">2026-09-05 周六 · 临时版 · 收盘</span><details><summary>报告说明 <small>只读</small></summary>${disclosure}</details>${template}</body></html>`;
  return { current, receipt, disclosure, template, html };
}
const context = { now: fixedNow, previousSourceSha: sourceSha };

test('default policy is inactive with no timer, preserving non-pilot report paths', () => {
  assert.equal(inactive.status, 'inactive');
  assert.equal(inactive.validFrom, null);
  assert.equal(inactive.expiresAt, null);
  const html = '<body><span class="date">2026-09-05 周六 · 临时版 · 收盘</span></body>';
  assert.equal(checkAssociationPublication(html, snapshot(fixedNow, 'inactive'), context).mode, 'legacy');
  assert.throws(() => checkAssociationPublication(html, null, context), /fresh trusted policy/);
});

test('active, expired and revoked pilots cannot be bypassed by removing both receipt and body marker', () => {
  const html = fixture().html.replace(` ${ASSOCIATION_BODY_ATTRIBUTE}`, '').replace(fixture().template, '').replace(fixture().disclosure, '');
  for (const current of [snapshot(), snapshot(fixedNow, 'revoked'), { ...snapshot(fixedNow - 7_200_000), checkedAt: new Date(fixedNow).toISOString() }]) {
    assert.throws(() => checkAssociationPublication(html, current, context), /stripping it does not select a legacy route/);
  }
});

test('ordinary recurring report validates current policy and exact previous source', () => {
  const { html, current } = fixture();
  assert.equal(checkAssociationPublication(html, current, context).freshRead, true);
  assert.throws(() => checkAssociationPublication(html, current, { ...context, previousSourceSha: 'e'.repeat(40) }), /bind/);
  assert.throws(() => checkAssociationPublication(html, current, { now: fixedNow }), /trusted previous source/);
});

test('publication rejects changed policy, revoked or expired authority and stale lookups', () => {
  const { html, current } = fixture();
  for (const bad of [
    { ...current, policyBlob: 'e'.repeat(40) },
    { ...current, policy: { ...current.policy, status: 'revoked' } },
    { ...current, checkedAt: new Date(fixedNow - 60_001).toISOString() },
    { ...current, checkedAt: new Date(fixedNow + 1).toISOString() },
  ]) assert.throws(() => checkAssociationPublication(html, bad, context));
  const expires = Date.parse(current.policy.expiresAt);
  assert.throws(() => checkAssociationPublication(html, { ...current, checkedAt: new Date(expires).toISOString() }, { ...context, now: expires }), /expired/);
  assert.equal(checkAssociationPublication(html, { ...current, policyCommit: 'e'.repeat(40) }, context).freshRead, true);
});

test('receipt/body marker canonical pair rejects tampering and inert imitations', () => {
  const { html, template, current } = fixture();
  for (const bad of [
    html.replace(template, ''), html.replace(` ${ASSOCIATION_BODY_ATTRIBUTE}`, ''),
    html.replace(ASSOCIATION_BODY_ATTRIBUTE, `${ASSOCIATION_BODY_ATTRIBUTE} ${ASSOCIATION_BODY_ATTRIBUTE}`),
    html.replace(ASSOCIATION_BODY_ATTRIBUTE, "data-account-scope-basis='owner-attested-recurring-v1'"),
    html.replace(ASSOCIATION_BODY_ATTRIBUTE, '').replace('<details>', `<details ${ASSOCIATION_BODY_ATTRIBUTE}>`),
    html.replace(template, template + template),
    html.replace(template, `<!--${template}-->`),
    html.replace(template, `<script>${template}</script>`),
    html.replace(template, template.replace('"schemaVersion":1', '"schemaVersion":1,"rawAccount":"secret"')),
  ]) assert.throws(() => checkAssociationPublication(bad, current, context));
});

test('canonical disclosure must be readable inside the initially folded explanation', () => {
  const { html, disclosure, current } = fixture();
  for (const bad of [
    html.replace('<details>', '<details open>'),
    html.replace('<details>', '<details hidden>'),
    html.replace('报告说明', '其它'),
    html.replace(disclosure, '').replace('</body>', disclosure + '</body>'),
    html.replace(disclosure, `<!--${disclosure}-->`),
    html.replace(disclosure, `<template>${disclosure}</template>`),
    html.replace(disclosure, `<textarea>${disclosure}</textarea>`),
    html.replace(disclosure, `<div aria-hidden="true">${disclosure}</div>`),
    html.replace(disclosure, `<div style="display: none">${disclosure}</div>`),
    html.replace(disclosure, disclosure + disclosure),
    html.replace('并非接口身份认证', '接口已核验'),
  ]) assert.throws(() => checkAssociationPublication(bad, current, context));
});

test('receipt-only continuity preserves historical association without pretending to renew it', () => {
  const { html, template } = fixture();
  const historical = checkAssociationPublication(html, null, { ...context, previousHtml: html, verifiedRecordsUpdate: true, now: fixedNow + 10 * 86_400_000 });
  assert.deepEqual(historical, { mode: 'historical-recurring', freshRead: false });
  assert.throws(() => checkAssociationPublication(html.replace(template, '').replace(` ${ASSOCIATION_BODY_ATTRIBUTE}`, ''), null, { ...context, previousHtml: html, verifiedRecordsUpdate: true }), /preserve the historical/);
});

test('AM and PM legacy paths remain unchanged while recurring cannot relabel its edition', () => {
  const { html, current } = fixture();
  for (const edition of ['早间版', '睡前版']) {
    assert.throws(() => checkAssociationPublication(html.replace('临时版', edition), current, context), /ad hoc only/);
    const plain = `<body><span class="date">2026-09-05 周六 · ${edition} · 收盘</span></body>`;
    assert.equal(checkAssociationPublication(plain, null, context).mode, 'legacy');
  }
  assert.equal(publicationEdition('<span class="date">2026-09-05 · 临&#26102;版 · 收盘</span>'), 'adhoc');
  assert.equal(publicationEdition('<span class="date">2026-09-05</span><p class="edition">临时版</p>'), 'adhoc');
  assert.throws(() => publicationEdition('<span class="date">2026-09-05 · 临时版 · 早间版</span>'), /ambiguous/);
});

function fullHtml(fragment) {
  const policy = JSON.parse(fs.readFileSync(path.join(repo, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
  const section = renderPolicySection(policy);
  const inputs = ['s1', 's2', 's3', 's4'].map(id => `<input type="radio" name="sec" id="${id}">`).join('') + ETF_TAB_RADIO_V1;
  const labels = ['概览', '风险', '配置', '待办'].map((label, index) => `<label for="s${index + 1}"${index === 3 ? ' aria-label="待办：0 项"' : ''}>${label}</label>`).join('') + ETF_TAB_LABEL_V1;
  return '<!doctype html>' + fragment.replace('<html>', `<html><head><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN-投资管理</title><style>${ETF_TAB_CSS_V1}</style></head>`)
    .replace(/(<body[^>]*>)/, '$1<!-- xuan-ib-handover:v1 --><h1>XUAN-投资管理</h1>')
    .replace('</body>', `<div class="tabs">${inputs}<div class="tabbar">${labels}</div><div class="pane p1"></div><div class="pane p2"></div><div class="pane p3"></div><div class="pane p4"></div><div class="pane p5">${section}</div></div></body>`);
}

test('handover guard integrates allowlisted inert receipt and trusted local snapshot without private manifest', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'association-publication-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { html, current } = fixture(Date.now());
  const candidate = path.join(temporary, 'candidate.html'), prior = path.join(temporary, 'prior.html'), policyFile = path.join(temporary, 'snapshot.json');
  const previous = fullHtml('<html><body><span class="date">2026-09-05 周六 · 早间版</span></body></html>');
  fs.writeFileSync(prior, previous);
  fs.writeFileSync(policyFile, JSON.stringify(current));
  const execute = source => {
    fs.writeFileSync(candidate, fullHtml(source));
    return spawnSync(process.execPath, [path.join(repo, 'scripts/handover-guard.mjs'), candidate, '2026-09-05', prior], {
      encoding: 'utf8', env: { ...process.env, XUAN_IB_ASSOCIATION_SNAPSHOT_JSON: policyFile,
        XUAN_IB_PREVIOUS_SOURCE_SHA: sourceSha, XUAN_IB_PREVIOUS_HTML_BLOB: 'f'.repeat(40) },
    });
  };
  const valid = execute(html);
  assert.equal(valid.status, 0, valid.stderr);
  assert.notEqual(execute(html.replace('临时版', '未标出版别')).status, 0);
  assert.notEqual(execute(html.replace(ASSOCIATION_BODY_ATTRIBUTE, '')).status, 0);
  assert.notEqual(execute(html.replace('并非接口身份认证', '接口身份已验证')).status, 0);
  assert.doesNotMatch(html, /manualConsent|rawAccount|financial|net_liquidation|token|cookie/i);
});

test('production gates discard any injected snapshot and recheck independently before publishing', () => {
  const read = name => fs.readFileSync(path.join(repo, '.github/workflows', name), 'utf8');
  const validate = read('validate-xuan-ib-handover.yml'), promote = read('promote-xuan-ib-handover.yml');
  assert.match(validate, /git archive origin\/main -- scripts/);
  for (const helper of ['scripts/xuan-ib-account-association.mjs', 'scripts/xuan-ib-account-association-publication.mjs']) assert.ok(validate.includes(helper));
  for (const workflow of [validate, promote]) {
    const calls = (workflow.match(/node (?:"[^"\n]*\/scripts\/handover-guard\.mjs"|scripts\/handover-guard\.mjs)/g) || []).length;
    assert.ok(calls > 0);
    assert.equal((workflow.match(/env -u XUAN_IB_ASSOCIATION_SNAPSHOT_JSON/g) || []).length, calls);
  }
  const finalStep = promote.slice(promote.indexOf('- name: Publish the verified page'));
  assert.ok(finalStep.indexOf('git fetch --no-tags origin main') < finalStep.indexOf('node scripts/handover-guard.mjs'));
  assert.ok(finalStep.indexOf('node scripts/handover-guard.mjs') < finalStep.indexOf('git push origin "$CANDIDATE_SHA:$source_tag"'));
  assert.ok(finalStep.indexOf('node scripts/handover-guard.mjs') < finalStep.indexOf('create-meta'));
  const guard = fs.readFileSync(path.join(repo, 'scripts/handover-guard.mjs'), 'utf8');
  assert.match(guard, /loadTrustedAssociationPolicy\(\{ cwd: process\.cwd\(\), requireActive: false \}\)/);
  assert.match(guard, /validateAssociationSnapshot\(snapshot, \{ now: Date\.now\(\), requireActive: false \}\)/);
});

test('policy, helpers and tests remain covered by exact-head owner approval and required tests', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/xuan-ib-policy-lock.yml'), 'utf8');
  const extension = [...workflow.matchAll(/protected_re="\$\{protected_re\}\|([^"\n]*)"/g)].map(match => match[1]).join('|');
  assert.ok(extension.includes('xuan-ib-account-association'));
  for (const filename of ['claude/xuan-ib-account-association-v1.json', 'claude/xuan-ib-account-association-v1.md',
    'scripts/xuan-ib-account-association.mjs', 'scripts/xuan-ib-account-association.test.mjs',
    'scripts/xuan-ib-account-association-publication.mjs', 'scripts/xuan-ib-account-association-publication.test.mjs',
    'scripts/xuan-ib-account-association-integration.test.mjs',
    'scripts/xuan-ib-association-test-fixture.mjs', 'scripts/xuan-ib-association-sources.test.mjs']) {
    assert.equal(spawnSync('grep', ['-Eq', extension], { input: `${filename}\n` }).status, 0, filename);
  }
  assert.match(workflow, /approval_line="\/approve-xuan-ib-maintenance \$head_sha"/);
  assert.match(workflow, /select\(\.author_association == "OWNER"\)/);
  const check = fs.readFileSync(path.join(repo, '.github/workflows/scripts-check.yml'), 'utf8');
  assert.match(check, /run: node --test scripts\/xuan-ib-account-association\.test\.mjs scripts\/xuan-ib-account-association-publication\.test\.mjs/);
  const owners = fs.readFileSync(path.join(repo, '.github/CODEOWNERS'), 'utf8');
  assert.match(owners, /\/claude\/xuan-ib-account-association\* @huanwujoy-crypto/);
});
