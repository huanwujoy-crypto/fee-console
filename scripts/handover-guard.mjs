#!/usr/bin/env node

import fs from 'node:fs';

const [file, expectedDate] = process.argv.slice(2);

const fail = (message) => {
  console.error(`handover guard failed: ${message}`);
  process.exit(1);
};

if (!file || !expectedDate) {
  console.error('usage: handover-guard.mjs FILE EXPECTED_DATE');
  process.exit(2);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) {
  fail('expected date must use YYYY-MM-DD');
}

let html;
try {
  html = fs.readFileSync(file, 'utf8');
} catch {
  fail('could not read the handover file');
}

const bytes = Buffer.byteLength(html);
if (bytes < 1_000 || bytes >= 2_000_000) {
  fail('file size is outside the approved range');
}

const count = (regex) => (html.match(regex) || []).length;
if (count(/<!doctype\s+html\b/gi) !== 1) fail('exactly one doctype is required');
if (count(/<html\b/gi) !== 1 || count(/<\/html\s*>/gi) !== 1) {
  fail('exactly one html document is required');
}
if (count(/<body\b/gi) !== 1 || count(/<\/body\s*>/gi) !== 1) {
  fail('exactly one body is required');
}
if (count(/<!--\s*xuan-ib-handover:v1\s*-->/gi) !== 1) {
  fail('the publication marker is missing');
}
if (!/<title>\s*XUAN-IB\s+睡前交接\s*<\/title>/i.test(html)) {
  fail('the approved title is missing');
}
if (!/<meta\b[^>]*name=["']apple-mobile-web-app-capable["'][^>]*content=["']yes["']/i.test(html)) {
  fail('the iPhone web-app capability is missing');
}
if (!/<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*content=["']XUAN-IB 交接["']/i.test(html)) {
  fail('the iPhone home-screen title is missing');
}
const visibleMarkup = html
  .replace(/<!--([\s\S]*?)-->/g, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
const primaryDates = [];
for (const match of visibleMarkup.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi)) {
  const classAttribute = match[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  if (!classAttribute || !classAttribute[2].split(/\s+/).includes('date')) continue;
  const text = match[2].replace(/<[^>]*>/g, ' ').trim();
  const date = text.match(/^(\d{4}-\d{2}-\d{2})\b/);
  primaryDates.push(date ? date[1] : 'invalid');
}
if (primaryDates.length !== 1 || primaryDates[0] !== expectedDate) {
  fail('exactly one primary data-date header must match the expected date');
}

const forbidden = [
  ['external script', /<script\b[^>]*\bsrc\s*=/i],
  ['embedded frame or object', /<(?:iframe|frame|embed|object)\b/i],
  ['protocol-relative URL', /[="'(\s]\/\/[A-Za-z0-9]/i],
  ['remote resource', /<(?:img|audio|video|source|track|link|image)\b|\bsrcset\s*=|\burl\s*\(|@import\b|<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i],
  ['form submission', /<form\b[^>]*\baction\s*=/i],
  ['network call', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i],
  ['browser storage or cookie access', /\b(?:localStorage|sessionStorage|document\.cookie)\b/i],
  ['dynamic code execution', /\b(?:eval|Function)\s*\(/i],
  ['external URL', /\bhttps?:\/\//i],
  ['executable URL', /\b(?:javascript|data\s*:\s*text\/html)\s*:/i],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(html)) fail(`${label} is not allowed`);
}

for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  if (/\bsrc\s*=/i.test(attrs)) fail('external script is not allowed');
  try {
    new Function(body);
  } catch {
    fail('inline script has invalid syntax');
  }
}

console.log(`handover guard passed: ${expectedDate}, ${bytes} bytes`);
