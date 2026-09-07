// Classification is reporting metadata, never an order or a fee input.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isIsoDate } from './daily-core.mjs';

export const STYLE_ACCOUNTS = Object.freeze({ schwab: 936249, webull: 1350094 });
const fail = code => { throw new Error(`STYLE_${code}`); };
const exact = (obj, keys) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)
      || Object.keys(obj).sort().join('|') !== [...keys].sort().join('|')) fail('SCHEMA');
};
const text = (s, max = 1000) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const iso = d => { if (!isIsoDate(d)) fail('DATE'); };
const identity = h => {
  if (!Object.values(STYLE_ACCOUNTS).includes(h.portfolioId)
      || !Number.isSafeInteger(h.holdingId) || h.holdingId <= 0
      || typeof h.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(h.ticker)
      || h.ticker === 'SGOV') fail('IDENTITY');
  return `${h.portfolioId}:${h.holdingId}`;
};
const amount = n => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e12) fail('AMOUNT');
};
const canonical = v => JSON.stringify(v, Object.keys(v).sort());
const ENTRY_KEYS = ['portfolioId', 'holdingId', 'ticker', 'style', 'effectiveFrom',
  'firstHeldOn', 'classifiedAt', 'classifier', 'reviewer', 'evidenceRef', 'rationale', 'reviewNote'];
export const classificationId = e => 'fee-style-' + crypto.createHash('sha256')
  .update(JSON.stringify([e.portfolioId, e.holdingId, e.ticker, e.style, e.effectiveFrom]))
  .digest('hex').slice(0, 24);

function validateEntry(e, saved = false) {
  exact(e, saved ? [...ENTRY_KEYS, 'id'] : ENTRY_KEYS);
  identity(e);
  if (!['growth', 'value'].includes(e.style)) fail('STYLE');
  iso(e.effectiveFrom); iso(e.firstHeldOn);
  if (e.firstHeldOn > e.effectiveFrom) fail('BEFORE_FIRST_HOLDING');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(e.classifiedAt)
      || !Number.isFinite(Date.parse(e.classifiedAt))
      || new Date(e.classifiedAt).toISOString().slice(0, 10) !== e.classifiedAt.slice(0, 10)
      || e.classifiedAt.slice(0, 10) < e.effectiveFrom) fail('CLASSIFIED_AT');
  for (const k of ['classifier', 'reviewer', 'evidenceRef', 'rationale', 'reviewNote']) {
    if (!text(e[k])) fail('EVIDENCE_REQUIRED');
  }
  if (e.classifier.trim().toLowerCase() === e.reviewer.trim().toLowerCase()) fail('INDEPENDENT_REVIEW');
  if (saved && e.id !== classificationId(e)) fail('ENTRY_ID');
}

/** Strict, deterministic resolver. Errors expose codes/row indexes, not holdings or amounts.
 * Evidence/reviewer fields are audit attestations, not proof of external research.
 * The caller must independently verify stable, complete API sources and review.
 */
export function resolveStyle({ input, registry, staticMap, date, sourceDates, stock, now = new Date() }) {
  exact(input, ['schemaVersion', 'date', 'portfolios', 'proposals']);
  if (input.schemaVersion !== 1 || input.date !== date) fail('INPUT_DATE');
  iso(date); amount(stock);
  if (!Array.isArray(input.portfolios) || input.portfolios.length !== 2
      || !Array.isArray(input.proposals) || input.proposals.length > 1000) fail('SCHEMA');
  if (!staticMap || staticMap.schemaVersion !== 1 || !Array.isArray(staticMap.holdings)) fail('STATIC_MAP');
  iso(staticMap.effectiveDate);
  const known = new Map();
  for (const e of staticMap.holdings) {
    const key = identity(e);
    if (known.has(key) || !['growth', 'value'].includes(e.style)) fail('STATIC_CONFLICT');
    known.set(key, e);
  }
  const saved = registry === undefined ? { schemaVersion: 1, entries: [] } : registry;
  exact(saved, ['schemaVersion', 'entries']);
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 10000) fail('REGISTRY');
  const learned = new Map();
  for (const e of saved.entries) {
    validateEntry(e, true);
    if (Date.parse(e.classifiedAt) > now.getTime()) fail('FUTURE_CLASSIFICATION');
    const key = identity(e), fixed = known.get(key);
    if (learned.has(key)) fail('REGISTRY_DUPLICATE');
    if (fixed && (fixed.ticker !== e.ticker || fixed.style !== e.style)) fail('STATIC_LEARNED_CONFLICT');
    learned.set(key, e);
  }
  const holdings = [], ids = new Set(), accountsSeen = new Set();
  for (const p of input.portfolios) {
    exact(p, ['account', 'portfolioId', 'sourceDate', 'stockTotalUsd', 'holdings']);
    if (!Object.hasOwn(STYLE_ACCOUNTS, p.account) || p.portfolioId !== STYLE_ACCOUNTS[p.account]
        || accountsSeen.has(p.account)) fail('ACCOUNT');
    accountsSeen.add(p.account); iso(p.sourceDate);
    if (p.sourceDate !== sourceDates[p.account] || p.sourceDate > date) fail('SOURCE_DATE');
    amount(p.stockTotalUsd);
    if (!Array.isArray(p.holdings) || p.holdings.length > 1000) fail('HOLDINGS');
    let total = 0;
    for (const h of p.holdings) {
      exact(h, ['holdingId', 'ticker', 'valueUsd']);
      const row = { ...h, portfolioId: p.portfolioId, sourceDate: p.sourceDate };
      const key = identity(row);
      if (ids.has(key)) fail('HOLDING_DUPLICATE');
      ids.add(key); amount(h.valueUsd); total += h.valueUsd; holdings.push(row);
    }
    if (Math.abs(total - p.stockTotalUsd) > 1) fail('ACCOUNT_STOCK_SUM');
  }
  if (Math.abs(holdings.reduce((s, h) => s + h.valueUsd, 0) - stock) > 1) fail('STOCK_SUM');
  const proposals = new Set(), appended = [];
  for (const e of input.proposals) {
    validateEntry(e);
    const key = identity(e), old = learned.get(key);
    if (proposals.has(key)) fail('PROPOSAL_DUPLICATE');
    proposals.add(key);
    const h = holdings.find(h => identity(h) === key);
    if (!h || h.ticker !== e.ticker) fail('PROPOSAL_NOT_HELD');
    if (e.effectiveFrom > h.sourceDate || Date.parse(e.classifiedAt) > now.getTime()) fail('FUTURE_CLASSIFICATION');
    const candidate = { ...e, id: classificationId(e) };
    if (old) {
      if (canonical(old) !== canonical(candidate)) fail('REGISTRY_IMMUTABLE');
      continue;
    }
    if (known.has(key)) fail('STATIC_IMMUTABLE');
    learned.set(key, candidate); appended.push(candidate);
  }
  let growth = 0, value = 0;
  const missing = [];
  for (const [i, h] of holdings.entries()) {
    const key = identity(h), fixed = known.get(key), learnedEntry = learned.get(key);
    if ((fixed && fixed.ticker !== h.ticker) || (learnedEntry && learnedEntry.ticker !== h.ticker)) fail('TICKER_CONFLICT');
    const e = fixed && staticMap.effectiveDate <= h.sourceDate ? fixed
      : learnedEntry && learnedEntry.effectiveFrom <= h.sourceDate ? learnedEntry : null;
    if (!e) { missing.push(i); continue; }
    if (e.style === 'growth') growth += h.valueUsd; else value += h.valueUsd;
  }
  if (missing.length) fail('MISSING_ROWS_' + missing.join('_'));
  return {
    growth: Math.round(growth * 100) / 100, value: Math.round(value * 100) / 100,
    registry: { schemaVersion: 1, entries: [...saved.entries, ...appended.sort((a, b) => a.id.localeCompare(b.id))] },
    newEventIds: appended.map(e => e.id).sort()
  };
}

export function readStyleInput(filename, repoRoot) {
  if (!path.isAbsolute(filename)) fail('FILE_ABSOLUTE');
  const target = fs.realpathSync(filename), relative = path.relative(fs.realpathSync(repoRoot), target);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep))) fail('FILE_IN_REPO');
  const read = () => {
    if (fs.realpathSync(filename) !== target) fail('FILE_CHANGED');
    const s = fs.statSync(target);
    if (!s.isFile() || s.size <= 0 || s.size > 5 * 1024 * 1024) fail('FILE_SIZE');
    if (s.mode & 0o077) fail('FILE_PERMISSIONS');
    return fs.readFileSync(target);
  };
  const bytes = read();
  const verify = () => { if (!bytes.equals(read())) fail('FILE_CHANGED'); };
  verify();
  return { input: JSON.parse(bytes.toString('utf8')), verify };
}
