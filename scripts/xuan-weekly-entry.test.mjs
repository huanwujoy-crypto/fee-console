import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../xuan-weekly/index.html',import.meta.url),'utf8');
test('direct final report with no login or temporary redirect',()=>{
  assert(html.includes('src="https://storage.googleapis.com/family-portfolio-gateway-xuan-weekly-public/weekly/latest.html"'));
  assert(!html.includes('storage.cloud.google.com'));
  assert(!html.includes('googleusercontent.com'));
  assert(html.includes('rel="noopener noreferrer"'));
});
test('static report frame requires no script, key, or local storage',()=>{
  assert(!/<script\b|<form\b/i.test(html));
  assert(html.includes('sandbox=""'));
  assert(!/localStorage|serviceWorker|latest\.enc|WEEKLY_PAGE_KEY|\$[0-9]/.test(html));
  assert(html.includes("default-src 'none'"));
});
test('install always opens portal, never report redirect',()=>{
  const m=JSON.parse(readFileSync(new URL('../xuan-weekly/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(m.start_url,'./');assert.equal(m.scope,'./');assert.equal(m.display,'standalone');
  assert(html.includes('rel="manifest"'));
});
