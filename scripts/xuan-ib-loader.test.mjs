import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
const latest = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url), 'utf8');

test('the fixed XUAN-IB URL is a stable cache-busting loader', () => {
  assert.match(loader, /new URL\("latest\.html", location\.href\)/);
  assert.match(loader, /Date\.now\(\)/);
  assert.match(loader, /fetch\(url, \{ cache: "no-store", credentials: "omit" \}\)/);
  assert.match(loader, /visibilitychange/);
  assert.match(loader, /requestSequence/);
  assert.match(loader, /Content-Security-Policy/);
  assert.match(loader, /default-src &apos;none&apos;/);
  assert.match(loader, /style-src &apos;unsafe-inline&apos;/);
  assert.match(loader, /<iframe[^>]+sandbox=""/);
  assert.doesNotMatch(loader, /serviceWorker/);
  assert.doesNotMatch(loader, /<!--\s*xuan-ib-handover:v1\s*-->/);
});

test('the variable handover stays separate from the fixed loader', () => {
  assert.match(latest, /<!--\s*xuan-ib-handover:v1\s*-->/);
  assert.match(latest, /<title>\s*XUAN-IB\s+睡前交接\s*<\/title>/);
  assert.match(latest, /apple-mobile-web-app-capable/);
});
