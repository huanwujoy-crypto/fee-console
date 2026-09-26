import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../xuan-weekly/index.html',import.meta.url),'utf8');
test('fixed private report link, no temporary Google redirect',()=>{
  assert(html.includes('href="https://storage.cloud.google.com/family-portfolio-gateway-xuan-weekly-private/weekly/latest.html"'));
  assert(!html.includes('googleusercontent.com'));
  assert(html.includes('rel="noopener noreferrer"'));
});
test('static portal does not fetch, store, decrypt or embed financial data',()=>{
  assert(!/<script\b|<iframe\b|<form\b/i.test(html));
  assert(!/localStorage|serviceWorker|latest\.enc|WEEKLY_PAGE_KEY|\$[0-9]/.test(html));
  assert(html.includes("default-src 'none'"));
});
test('install always opens portal, never report redirect',()=>{
  const m=JSON.parse(readFileSync(new URL('../xuan-weekly/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(m.start_url,'./');assert.equal(m.scope,'./');assert.equal(m.display,'standalone');
  assert(html.includes('請勿在跳轉後的報告頁安裝'));
});
