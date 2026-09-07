import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStyle, readStyleInput } from './fee-style-registry.mjs';

const fixture = () => ({
  date: '2026-09-06', sourceDates: { schwab: '2026-09-04', webull: '2026-09-04' }, stock: 300,
  now: new Date('2026-09-07T00:00:00Z'),
  staticMap: { schemaVersion: 1, effectiveDate: '2026-08-28', holdings: [
    { portfolioId: 936249, holdingId: 1, ticker: 'TESTA', style: 'value' }
  ] },
  input: { schemaVersion: 1, date: '2026-09-06', portfolios: [
    { account: 'schwab', portfolioId: 936249, sourceDate: '2026-09-04', stockTotalUsd: 100,
      holdings: [{ holdingId: 1, ticker: 'TESTA', valueUsd: 100 }] },
    { account: 'webull', portfolioId: 1350094, sourceDate: '2026-09-04', stockTotalUsd: 200,
      holdings: [{ holdingId: 2, ticker: 'TESTB', valueUsd: 200 }] }
  ], proposals: [{ portfolioId: 1350094, holdingId: 2, ticker: 'TESTB', style: 'growth',
    effectiveFrom: '2026-09-03', firstHeldOn: '2026-09-03', classifiedAt: '2026-09-06T12:00:00Z',
    classifier: 'Claude', reviewer: 'Codex', evidenceRef: 'https://example.test/company',
    rationale: 'Synthetic verified business evidence', reviewNote: 'Independent synthetic review' }] }
});
test('new position computes totals, then persists and reuses immutable decision', () => {
  const f = fixture(), r = resolveStyle(f);
  assert.equal(r.growth, 200); assert.equal(r.value, 100); assert.equal(r.newEventIds.length, 1);
  const again = resolveStyle({ ...f, registry: r.registry });
  assert.deepEqual(again.registry, r.registry); assert.deepEqual(again.newEventIds, []);
  f.input.proposals = [];
  assert.equal(resolveStyle({ ...f, registry: r.registry }).growth, 200);
});
const badCases = [
  ['missing classification has source row index', f => { f.input.proposals = []; }, /MISSING_ROWS_1/],
  ['duplicate stock identity', f => { f.input.portfolios[1].holdings.push({ ...f.input.portfolios[1].holdings[0] }); }, /HOLDING_DUPLICATE/],
  ['same ticker new holding cannot inherit', f => { f.input.proposals = []; f.input.portfolios[1].holdings[0] = { holdingId: 3, ticker: 'TESTA', valueUsd: 200 }; }, /MISSING_ROWS_1/],
  ['ticker change', f => { f.input.portfolios[0].holdings[0].ticker = 'CHANGED'; }, /TICKER_CONFLICT/],
  ['unknown account', f => { f.input.portfolios[0].portfolioId = 7; }, /ACCOUNT/],
  ['duplicate account', f => { f.input.portfolios[1] = structuredClone(f.input.portfolios[0]); }, /ACCOUNT/],
  ['negative amount', f => { f.input.portfolios[0].holdings[0].valueUsd = -1; }, /AMOUNT/],
  ['per account missing value', f => { f.input.portfolios[0].stockTotalUsd = 102; }, /ACCOUNT_STOCK_SUM/],
  ['total missing value', f => { f.stock = 302; }, /STOCK_SUM/],
  ['source date mismatch', f => { f.input.portfolios[1].sourceDate = '2026-09-03'; }, /SOURCE_DATE/],
  ['future classification cannot classify older source', f => { f.input.proposals[0].effectiveFrom = '2026-09-05'; }, /FUTURE_CLASSIFICATION/],
  ['future audit time', f => { f.input.proposals[0].classifiedAt = '2026-09-08T00:00:00Z'; }, /FUTURE_CLASSIFICATION/],
  ['classification before first holding', f => { f.input.proposals[0].firstHeldOn = '2026-09-04'; }, /BEFORE_FIRST_HOLDING/],
  ['no evidence', f => { f.input.proposals[0].rationale = ''; }, /EVIDENCE_REQUIRED/],
  ['reviewer cannot self approve', f => { f.input.proposals[0].reviewer = ' claude '; }, /INDEPENDENT_REVIEW/],
  ['SGOV cannot enter stock universe', f => { f.input.portfolios[0].holdings[0].ticker = 'SGOV'; }, /IDENTITY/],
  ['unknown fields rejected', f => { f.input.unexpected = true; }, /SCHEMA/],
  ['extra unrelated proposal', f => { f.input.proposals[0].holdingId = 9; }, /PROPOSAL_NOT_HELD/],
  ['duplicate proposal', f => { f.input.proposals.push({ ...f.input.proposals[0] }); }, /PROPOSAL_DUPLICATE/],
  ['invalid style', f => { f.input.proposals[0].style = 'unknown'; }, /STYLE_STYLE/],
  ['no static historical lookahead', f => { f.staticMap.effectiveDate = '2026-09-05'; }, /MISSING_ROWS_0/]
];
for (const [name, change, error] of badCases) test(name, () => {
  const f = fixture(); change(f); assert.throws(() => resolveStyle(f), error);
});
test('saved records reject mutation, duplicates, forged ids and later static conflicts', () => {
  const f = fixture(), r = resolveStyle(f);
  f.registry = r.registry;
  f.input.proposals[0].style = 'value';
  assert.throws(() => resolveStyle(f), /REGISTRY_IMMUTABLE/);
  f.input.proposals = [];
  f.staticMap.holdings.push({ ...r.registry.entries[0], style: 'value' });
  assert.throws(() => resolveStyle(f), /STATIC_LEARNED_CONFLICT/);
  f.staticMap.holdings.pop();
  f.registry.entries.push({ ...f.registry.entries[0] });
  assert.throws(() => resolveStyle(f), /REGISTRY_DUPLICATE/);
  f.registry.entries.pop(); f.registry.entries[0].id = 'changed';
  assert.throws(() => resolveStyle(f), /ENTRY_ID/);
});
test('learned entry cannot be used for historical source before effective date', () => {
  const f = fixture(); f.registry = resolveStyle(f).registry; f.input.proposals = [];
  f.date = f.input.date = '2026-09-02';
  for (const p of f.input.portfolios) p.sourceDate = f.sourceDates[p.account] = f.date;
  assert.throws(() => resolveStyle(f), /MISSING_ROWS_1/);
});
test('empty equity portfolios valid; no phantom notifications', () => {
  const f = fixture(); f.stock = 0; f.input.proposals = [];
  for (const p of f.input.portfolios) { p.holdings = []; p.stockTotalUsd = 0; }
  assert.equal(resolveStyle(f).growth, 0);
});
test('private input path guards repository files, symlinks, changed bytes and size', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'style-file-'));
  t.after(() => fs.rmSync(d, { recursive: true }));
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  const source = path.join(d, 'input.json'); fs.writeFileSync(source, '{}', { mode: 0o600 });
  const s = readStyleInput(source, repo); assert.deepEqual(s.input, {}); s.verify();
  fs.writeFileSync(source, '{"changed":true}'); assert.throws(s.verify, /FILE_CHANGED/);
  assert.throws(() => readStyleInput('relative.json', repo), /FILE_ABSOLUTE/);
  const inside = path.join(repo, 'inside.json'); fs.writeFileSync(inside, '{}');
  const link = path.join(d, 'link.json'); fs.symlinkSync(inside, link);
  assert.throws(() => readStyleInput(link, repo), /FILE_IN_REPO/);
  fs.writeFileSync(source, ''); assert.throws(() => readStyleInput(source, repo), /FILE_SIZE/);
  fs.writeFileSync(source, '{}'); fs.chmodSync(source, 0o644);
  assert.throws(() => readStyleInput(source, repo), /FILE_PERMISSIONS/);
});
