import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
const latest = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url), 'utf8');
const promotion = fs.readFileSync(new URL('../.github/workflows/promote-xuan-ib-handover.yml', import.meta.url), 'utf8');
const validation = fs.readFileSync(new URL('../.github/workflows/validate-xuan-ib-handover.yml', import.meta.url), 'utf8');
const uiPrCheck = fs.readFileSync(new URL('../.github/workflows/ui-pr-check.yml', import.meta.url), 'utf8');
const policyLock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
const metadata = JSON.parse(fs.readFileSync(new URL('../xuan-ib/latest.meta.json', import.meta.url), 'utf8'));

test('the fixed XUAN-IB URL is a stable cache-busting loader', () => {
  assert.match(loader, /new URL\("latest\.html", location\.href\)/);
  assert.match(loader, /Date\.now\(\)/);
  assert.match(loader, /fetch\(url, \{/);
  assert.match(loader, /cache: "no-store"/);
  assert.match(loader, /credentials: "omit"/);
  assert.match(loader, /signal: controller\.signal/);
  assert.match(loader, /controller\.abort\(\), 10_000/);
  assert.match(loader, /error\.name === "AbortError" \|\| error instanceof TypeError/);
  assert.match(loader, /replacement\.src = url/);
  assert.match(loader, /正在切换直接模式/);
  assert.match(loader, /内容未校验/);
  assert.match(loader, /replacement\.addEventListener\("load"/);
  assert.match(loader, /lastSuccess = Date\.now\(\);/);
  assert.match(loader, /replacement\.setAttribute\("sandbox", ""\)/);
  assert.match(loader, /replacement\.setAttribute\("referrerpolicy", "no-referrer"\)/);
  assert.match(loader, /if \(request !== requestSequence\) \{/);
  assert.match(loader, /lastAttempt = Date\.now\(\)/);
  assert.match(loader, /Date\.now\(\) - lastAttempt > 5 \* 60_000/);
  assert.match(loader, /visibilitychange/);
  assert.match(loader, /location\.replace\(url\)/);
  assert.match(loader, /event\.persisted/);
  assert.match(loader, /数据 \$\{dataDate\(html\)\}/);
  assert.match(loader, /loaderBuild = "2026-08-26\.1"/);
  assert.match(loader, /requestSequence/);
  assert.match(loader, /Content-Security-Policy/);
  assert.match(loader, /default-src &apos;none&apos;/);
  assert.match(loader, /style-src &apos;unsafe-inline&apos;/);
  assert.match(loader, /<iframe[^>]+sandbox=""/);
  assert.doesNotMatch(loader, /serviceWorker/);
  assert.doesNotMatch(loader, /<!--\s*xuan-ib-handover:v1\s*-->/);
});

test('validation and promotion accept a verified single-file candidate based on a trusted main ancestor', () => {
  assert.match(validation, /git merge-base --is-ancestor "\$candidate_parent" origin\/main/);
  assert.match(validation, /git diff --name-only "\$candidate_parent\.\.HEAD"/);
  assert.match(validation, /git rev-list --first-parent --count/);
  assert.match(validation, /candidate_lag > 50/);
  assert.match(validation, /candidate_epoch < now_epoch - 172800/);
  assert.match(validation, /parent_epoch < now_epoch - 604800/);
  assert.match(validation, /candidate_parent" != "\$current_main/);
  assert.doesNotMatch(validation, /git rev-parse "HEAD\^"\) != "\$base_sha"/);
  assert.match(promotion, /if ! candidate_parent=\$\(git rev-parse "\$candidate_ref\^" 2>\/dev\/null\)/);
  assert.match(promotion, /git merge-base --is-ancestor "\$candidate_parent" origin\/main/);
  assert.match(promotion, /git diff --name-only "\$candidate_parent\.\.\$candidate_ref"/);
  assert.match(promotion, /git rev-list --first-parent --count/);
  assert.match(promotion, /candidate_lag > 50/);
  assert.match(promotion, /commit_epoch < now_epoch - 172800/);
  assert.match(promotion, /parent_epoch < now_epoch - 604800/);
  assert.match(promotion, /candidate_parent" != "\$base_sha/);
  assert.match(promotion, /if ! candidate_blob=\$\(git rev-parse "\$candidate_ref:xuan-ib\/index\.html" 2>\/dev\/null\)/);
  assert.match(promotion, /candidate_blob" == "\$published_blob/);
  assert.match(promotion, /git rev-list origin\/main -- xuan-ib\/latest\.html/);
  assert.match(promotion, /candidate_blob" == "\$historical_blob/);
  assert.match(promotion, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(promotion, /xuan-ib\/latest\.meta\.json/);
  assert.match(promotion, /xuan-ib-promotion\.mjs select/);
  assert.match(promotion, /if ! commit_api_json=\$\(curl --fail --silent --show-error/);
  assert.match(promotion, /if ! node scripts\/handover-guard\.mjs/);
  assert.match(promotion, /Skipping \$branch_name: its handover page failed validation/);
  assert.match(promotion, /git add xuan-ib\/latest\.html xuan-ib\/latest\.meta\.json/);
  assert.match(promotion, /Published metadata source is not a verified Claude commit/);
  assert.match(promotion, /contents\/xuan-ib\/index\.html\?ref=\$meta_source_sha/);
  assert.match(promotion, /refs\/tags\/xuan-ib-published\/\$\{source_data_date\}/);
  assert.match(promotion, /refs\/tags\/xuan-ib-published\/\$\{DATA_DATE\}/);
  assert.doesNotMatch(promotion, /published_commit_epoch/);
  assert.doesNotMatch(promotion, /multiple valid handovers are waiting/);
  assert.doesNotMatch(promotion, /git merge-base --is-ancestor origin\/main "\$candidate_ref"/);
});

test('trusted publication metadata matches the currently published Git blob', () => {
  assert.equal(metadata.schemaVersion, 1);
  assert.match(metadata.sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(metadata.sourceCommitEpoch, 1787757398);
  assert.equal(metadata.dataDate, '2026-08-26');
  assert.equal(metadata.htmlBlob, 'f8ea7e14fe6db4573fd3d576ec73b6b774b058a7');
});

test('ordinary PRs cannot replace either fixed phone page or trusted metadata', () => {
  assert.match(uiPrCheck, /xuan-ib\/\(index\\\.html\|latest\\\.html\|latest\\\.meta\\\.json\)/);
  assert.match(uiPrCheck, /metadata seed PR must not replace the phone loader/);
});

test('a base-controlled policy lock protects the publication code itself', () => {
  assert.match(policyLock, /pull_request_target/);
  assert.match(policyLock, /name: xuan-ib-policy-lock/);
  assert.match(policyLock, /workflows\//);
  assert.match(policyLock, /handover-guard/);
  assert.match(policyLock, /xuan-ib\//);
  assert.match(policyLock, /\.github\/\(CODEOWNERS\$\|workflows\/\|actions\/\)/);
  assert.match(policyLock, /previous_filename/);
  assert.match(policyLock, /EXPECTED_FILE_COUNT/);
  assert.match(policyLock, /returned_file_count > 1000/);
  assert.doesNotMatch(policyLock, /actions\/checkout/);
});

test('the variable handover stays separate from the fixed loader', () => {
  assert.match(latest, /<!--\s*xuan-ib-handover:v1\s*-->/);
  assert.match(latest, /<title>\s*XUAN-IB\s+睡前交接\s*<\/title>/);
  assert.match(latest, /apple-mobile-web-app-capable/);
});
