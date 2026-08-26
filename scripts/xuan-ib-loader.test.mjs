import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
const latest = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url), 'utf8');
const promotion = fs.readFileSync(new URL('../.github/workflows/promote-xuan-ib-handover.yml', import.meta.url), 'utf8');

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

test('promotion accepts a verified single-file candidate based on a trusted main ancestor', () => {
  assert.match(promotion, /candidate_parent=\$\(git rev-parse "\$candidate_ref\^"\)/);
  assert.match(promotion, /git merge-base --is-ancestor "\$candidate_parent" origin\/main/);
  assert.match(promotion, /git diff --name-only "\$candidate_parent\.\.\$candidate_ref"/);
  assert.match(promotion, /candidate_blob=\$\(git rev-parse "\$candidate_ref:xuan-ib\/index\.html"\)/);
  assert.match(promotion, /candidate_blob" == "\$published_blob/);
  assert.match(promotion, /git rev-list origin\/main -- xuan-ib\/latest\.html/);
  assert.match(promotion, /candidate_blob" == "\$historical_blob/);
  assert.match(promotion, /data_date" < "\$published_date/);
  assert.match(promotion, /commit_epoch <= published_commit_epoch/);
  assert.doesNotMatch(promotion, /git merge-base --is-ancestor origin\/main "\$candidate_ref"/);
});

test('the variable handover stays separate from the fixed loader', () => {
  assert.match(latest, /<!--\s*xuan-ib-handover:v1\s*-->/);
  assert.match(latest, /<title>\s*XUAN-IB\s+睡前交接\s*<\/title>/);
  assert.match(latest, /apple-mobile-web-app-capable/);
});
