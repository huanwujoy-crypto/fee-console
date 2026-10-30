import crypto from 'node:crypto';
import {loadStyleProposal,mergeStyleProposal} from './fee-cloud-producer.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStyle, resolveAssetAllocation, readStyleInput, summarizeTopHoldings } from './fee-style-registry.mjs';

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
test('top holdings aggregate matching tickers and use deterministic value order', () => {
  const f = fixture();
  f.input.portfolios[0].holdings.push({ holdingId: 3, ticker: 'TESTB', valueUsd: 150 });
  assert.deepEqual(summarizeTopHoldings(f.input), [
    { ticker: 'TESTB', value: 350 },
    { ticker: 'TESTA', value: 100 }
  ]);
  assert.throws(() => summarizeTopHoldings({ portfolios: [{ holdings: [{ ticker: 'SGOV', valueUsd: 1 }] }] }),
    /STYLE_TOP_HOLDINGS/);
});
test('identity-bound leveraged exposure folds VSTL into VST without changing raw holdings', () => {
  const input = { date: '2026-09-30', portfolios: [
    { portfolioId: 936249, sourceDate: '2026-09-30', holdings: [
      { holdingId: 10, ticker: 'VST', valueUsd: 100 },
      { holdingId: 11, ticker: 'OTHER', valueUsd: 80 }
    ] },
    { portfolioId: 1350094, sourceDate: '2026-09-30', holdings: [
      { holdingId: 29274212, ticker: 'VSTL', valueUsd: 30 }
    ] }
  ] };
  const rules = [{ portfolioId: 1350094, holdingId: 29274212, ticker: 'VSTL', targetTicker: 'VST',
    multiplier: 2, effectiveFrom: '2026-09-30', basis: 'Owner-confirmed 2x underlying exposure' }];
  assert.deepEqual(summarizeTopHoldings(input, 3, rules), [
    { ticker: 'VST', value: 160 },
    { ticker: 'OTHER', value: 80 }
  ]);
  assert.equal(input.portfolios[1].holdings[0].valueUsd, 30, 'raw market value remains unchanged');
  assert.throws(() => summarizeTopHoldings(input, 3, [{ ...rules[0], ticker: 'WRONG' }]), /STYLE_TOP_HOLDINGS/);
  assert.throws(() => summarizeTopHoldings(input, 3, [{ ...rules[0], multiplier: 0 }]), /STYLE_TOP_HOLDINGS/);
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
  ['future classification cannot classify older source', f => { f.input.proposals[0].effectiveFrom = f.input.proposals[0].firstHeldOn = '2026-09-05'; }, /FUTURE_CLASSIFICATION/],
  ['initial classification must cover the first holding day', f => { f.input.proposals[0].effectiveFrom = '2026-09-04'; }, /EFFECTIVE_FIRST_HOLDING/],
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
test('weekend lookback reuses initial decision from first-held date without mutation', () => {
  const f = fixture(); f.registry = resolveStyle(f).registry; f.input.proposals = [];
  const saved = structuredClone(f.registry);
  f.date = f.input.date = '2026-09-03';
  for (const p of f.input.portfolios) p.sourceDate = f.sourceDates[p.account] = f.date;
  const r = resolveStyle(f);
  assert.equal(r.growth, 200); assert.deepEqual(r.registry, saved); assert.deepEqual(r.newEventIds, []);
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
  fs.chmodSync(source, 0o600); fs.chmodSync(d, 0o755);
  assert.throws(() => readStyleInput(source, repo), /DIRECTORY_PERMISSIONS/);
  fs.chmodSync(d, 0o700);
});


test('independently reviewed gold is isolated from both equity styles and reused immutably', () => {
  const f = fixture();
  f.input.proposals[0].style = 'gold';
  const result = resolveStyle(f);
  assert.equal(result.growth, 0); assert.equal(result.value, 100); assert.equal(result.gold, 200);
  assert.equal(result.growth + result.value + result.gold, f.stock);
  const again = resolveStyle({ ...f, registry: result.registry });
  assert.deepEqual(again.registry, result.registry); assert.deepEqual(again.newEventIds, []);
  f.input.proposals[0].style = 'value';
  assert.throws(() => resolveStyle({ ...f, registry: result.registry }), /REGISTRY_IMMUTABLE/);
});
test('legacy reviewed holdings keep original totals and omit zero gold', () => {
  assert.equal(Object.hasOwn(resolveStyle(fixture()), 'gold'), false);
});


// One-time transport uses the unchanged original resolver (synthetic only).
{

const D='2026-10-12';
const proposal=()=>({portfolioId:936249,holdingId:901,ticker:'AMZN',style:'growth',
  firstHeldOn:'2025-11-04',effectiveFrom:'2025-11-04',classifiedAt:'2026-10-13T00:00:00Z',
  classifier:'synthetic-A',reviewer:'synthetic-B',evidenceRef:'https://example.test/synthetic',
  rationale:'Synthetic only',reviewNote:'Synthetic only'});
const input=()=>({schemaVersion:1,date:D,portfolios:[
  {account:'schwab',portfolioId:936249,sourceDate:D,stockTotalUsd:100,
    holdings:[{holdingId:901,ticker:'AMZN',valueUsd:100}]},
  {account:'webull',portfolioId:1350094,sourceDate:D,stockTotalUsd:0,holdings:[]}
],proposals:[]});
const resolve=source=>resolveStyle({input:source,registry:{schemaVersion:1,entries:[]},
  staticMap:{schemaVersion:1,effectiveDate:'2026-08-28',holdings:[]},date:D,
  sourceDates:{schwab:D,webull:D},stock:100,now:new Date('2026-10-13T01:00:00Z')});
const fixture=t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'style-proposal-test-'));fs.chmodSync(dir,0o700);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const repo=path.join(dir,'repo');fs.mkdirSync(repo);
  const file=path.join(dir,'proposal.json');
  const save=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
  save({schema:'fee-console.style-proposal.v1',targetDate:D,proposal:proposal()});
  const lock=()=>JSON.stringify({schema:'fee-console.style-proposal-lock.v1',targetDate:D,
    proposalSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    portfolioId:936249,holdingId:901,ticker:'AMZN',style:'growth',firstHeldOn:'2025-11-04',effectiveFrom:'2025-11-04'});
  return {dir,repo,file,save,lock};
};
test('absent proposal is unchanged ordinary source input',()=>{
  const source=input(),loaded=loadStyleProposal(undefined,D,'unused');
  assert.equal(mergeStyleProposal(source,loaded.proposal),source);loaded.checkCurrent();
});
test('one private target-bound proposal merges without changing source holdings or totals',t=>{
  const f=fixture(t),loaded=loadStyleProposal(f.file,D,f.repo,f.lock()),source=input(),before=structuredClone(source);
  loaded.checkCurrent();const merged=mergeStyleProposal(source,loaded.proposal);
  assert.deepEqual(source,before);assert.deepEqual({...merged,proposals:[]},before);
  assert.equal(resolve(merged).newEventIds.length,1);
});
test('wrong date, schema, extra keys and multiple proposals reject',t=>{
  const f=fixture(t);
  for(const body of [
    {schema:'fee-console.style-proposal.v1',targetDate:'2026-10-09',proposal:proposal()},
    {schema:'wrong',targetDate:D,proposal:proposal()},
    {schema:'fee-console.style-proposal.v1',targetDate:D,proposal:proposal(),approved:true},
    {schema:'fee-console.style-proposal.v1',targetDate:D,proposal:[proposal(),proposal()]}
  ]){f.save(body);assert.throws(()=>loadStyleProposal(f.file,D,f.repo,f.lock()),/^Error: FEE_CLOUD_STYLE_PROPOSAL_INPUT$/);}
});
test('original identity, independent review, effective date and amount gates remain enforced',t=>{
  const f=fixture(t);
  for(const [change,error]of [
    [p=>p.reviewer=p.classifier,/INDEPENDENT_REVIEW/],
    [p=>p.evidenceRef='',/EVIDENCE_REQUIRED/]
  ]){const p=proposal();change(p);f.save({schema:'fee-console.style-proposal.v1',targetDate:D,proposal:p});
    assert.throws(()=>resolve(mergeStyleProposal(input(),loadStyleProposal(f.file,D,f.repo,f.lock()).proposal)),error);}
});
test('existing source proposals cannot be replaced',()=>{
  const source=input();source.proposals=[proposal()];
  assert.throws(()=>mergeStyleProposal(source,proposal()),/CONFLICT/);
});
test('file permissions, relative or repository paths and symlinks reject',t=>{
  const f=fixture(t);assert.throws(()=>loadStyleProposal('relative.json',D,f.repo,f.lock()),/INPUT/);
  fs.chmodSync(f.file,0o644);assert.throws(()=>loadStyleProposal(f.file,D,f.repo,f.lock()),/INPUT/);fs.chmodSync(f.file,0o600);
  const inside=path.join(f.repo,'proposal.json');fs.copyFileSync(f.file,inside);fs.chmodSync(inside,0o600);
  assert.throws(()=>loadStyleProposal(inside,D,f.repo,f.lock()),/INPUT/);
  const link=path.join(f.dir,'link.json');fs.symlinkSync(f.file,link);
  assert.throws(()=>loadStyleProposal(link,D,f.repo,f.lock()),/INPUT/);
  fs.chmodSync(f.dir,0o755);assert.throws(()=>loadStyleProposal(f.file,D,f.repo,f.lock()),/INPUT/);
});
test('changed or replaced same-byte proposal stops with fixed private-safe code',t=>{
  const f=fixture(t),loaded=loadStyleProposal(f.file,D,f.repo,f.lock());
  const bytes=fs.readFileSync(f.file),replacement=path.join(f.dir,'replacement.json');
  fs.writeFileSync(replacement,bytes,{mode:0o600});
  assert.notEqual(fs.statSync(replacement).ino,fs.statSync(f.file).ino);
  fs.renameSync(replacement,f.file);
  assert.throws(loaded.checkCurrent,/CHANGED/);
  const fresh=loadStyleProposal(f.file,D,f.repo,f.lock());f.save({private:'not logged'});
  assert.throws(fresh.checkCurrent,/^Error: FEE_CLOUD_STYLE_PROPOSAL_CHANGED$/);
});
test('oversized, empty and malformed file reject without contents or paths in errors',t=>{
  const f=fixture(t);
  for(const bytes of ['', 'private garbage secret=123', 'x'.repeat(65537)]){
    fs.writeFileSync(f.file,bytes);assert.throws(()=>loadStyleProposal(f.file,D,f.repo,f.lock()),
      /^Error: FEE_CLOUD_STYLE_PROPOSAL_INPUT$/);}
});
test('one-time lock rejects absent/wrong lock, other target/hash/account/holding/style/dates',t=>{
  const f=fixture(t),lock=JSON.parse(f.lock());
  assert.throws(()=>loadStyleProposal(f.file,D,f.repo),/LOCK/);
  assert.throws(()=>loadStyleProposal(f.file,'2026-10-13',f.repo,JSON.stringify(lock)),/LOCK/);
  for(const change of [x=>x.portfolioId=1350094,x=>x.style='value',x=>x.firstHeldOn=D,x=>x.targetDate='2026-10-13']){
    const bad={...lock};change(bad);assert.throws(()=>loadStyleProposal(f.file,D,f.repo,JSON.stringify(bad)),/LOCK/);
  }
  const hash={...lock,proposalSha256:'a'.repeat(64)};
  assert.throws(()=>loadStyleProposal(f.file,D,f.repo,JSON.stringify(hash)),/HASH/);
  for(const change of [p=>p.holdingId=902,p=>p.portfolioId=1350094,p=>p.ticker='OTHER',p=>p.style='value',p=>p.effectiveFrom=D]){
    const p=proposal();change(p);f.save({schema:'fee-console.style-proposal.v1',targetDate:D,proposal:p});
    const bound={...lock,proposalSha256:crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex')};
    assert.throws(()=>loadStyleProposal(f.file,D,f.repo,JSON.stringify(bound)),/INPUT/);
  }
});
}


const assetFixture = () => {
  const f = fixture();
  f.input = { ...f.input, schemaVersion: 2, mode: 'sharesight-asset-type-v1', proposals: [] };
  for (const p of f.input.portfolios) for (const h of p.holdings) h.sourceAssetType = 'ordinary_shares';
  return f;
};
test('source asset mode merges ordinary stocks without growth/value proposals or registry writes', () => {
  const f = assetFixture(), before = structuredClone(f);
  const r = resolveAssetAllocation(f);
  assert.deepEqual(r.assetAllocation, {schemaVersion: 1, mode: 'sharesight-asset-type-v1',
    equity: 300, etf: 0, bond: 0, cash: 0, gold: 0, other: 0, unclassified: 0});
  assert.deepEqual(r.newEventIds, []);
  assert.equal(Object.hasOwn(r, 'registry'), false);
  assert.equal(Object.hasOwn(r, 'growth'), false);
  assert.equal(Object.hasOwn(r, 'value'), false);
  assert.deepEqual(f, before);
});
for (const [type, bucket] of [['exchange_traded_fund', 'etf'], ['bond', 'bond'],
  ['fixed_interest', 'bond'], ['cash', 'cash'], ['option', 'other'], ['private_equity', 'other'],
  ['managed_fund', 'other'], ['preference_shares', 'other'], ['unrecognized_product', 'unclassified'],
  ['', 'unclassified'], [null, 'unclassified']]) test(`source asset mode keeps ${type} outside stocks`, () => {
  const f = assetFixture(); f.input.portfolios[1].holdings[0].sourceAssetType = type;
  const r = resolveAssetAllocation(f).assetAllocation;
  assert.equal(r.equity, 100); assert.equal(r[bucket], 200);
  assert.equal(['equity','etf','bond','cash','gold','other','unclassified'].reduce((s,k)=>s+r[k],0), f.stock);
});
test('gold is an effective exact-identity historical override, never a ticker-only guess', () => {
  const f = assetFixture(); f.input.portfolios[0].holdings[0].sourceAssetType = 'exchange_traded_fund';
  f.staticMap.holdings[0].style = 'gold';
  assert.equal(resolveAssetAllocation(f).assetAllocation.gold, 100);
  f.input.portfolios[0].holdings[0].holdingId = 10;
  assert.equal(resolveAssetAllocation(f).assetAllocation.etf, 100);
  f.input.portfolios[0].holdings[0].holdingId = 1;
  f.staticMap.effectiveDate = '2026-09-05';
  assert.equal(resolveAssetAllocation(f).assetAllocation.etf, 100);
  f.staticMap.effectiveDate = '2026-08-28';
  f.input.portfolios[0].holdings[0].sourceAssetType = 'ordinary_shares';
  assert.equal(resolveAssetAllocation(f).assetAllocation.equity, 300);
});
test('saved gold decision is read without mutating historical registry or creating new decisions', () => {
  const old = fixture(); old.input.proposals[0].style = 'gold';
  const registry = resolveStyle(old).registry, bytes = JSON.stringify(registry);
  const f = assetFixture(); f.registry = registry;
  f.input.portfolios[1].holdings[0].sourceAssetType = 'exchange_traded_fund';
  assert.equal(resolveAssetAllocation(f).assetAllocation.gold, 200);
  assert.equal(JSON.stringify(registry), bytes);
});
test('verified GLD instrument stays gold across fee portfolios and new holding identities',()=>{
  const f=assetFixture(),before=JSON.stringify(f.registry);
  for(const p of f.input.portfolios)for(const h of p.holdings){h.holdingId+=100;h.ticker='GLD';h.sourceAssetType='exchange_traded_fund';h.sourceInstrument={instrumentId:22272,instrumentCode:'GLD',market:'NYSE',currency:'USD'};}
  const result=resolveAssetAllocation(f);assert.equal(result.assetAllocation.gold,300);assert.equal(result.assetAllocation.etf,0);
  assert.equal(JSON.stringify(f.registry),before);assert.deepEqual(result.newEventIds,[]);
});
for(const change of [h=>h.sourceInstrument.instrumentId=22273,h=>h.sourceInstrument.market='NASDAQ',h=>h.sourceAssetType='ordinary_shares',h=>{delete h.sourceInstrument;}])
test('gold instrument rule does not guess other securities, markets, ordinary shares or missing identity',()=>{
  const f=assetFixture(),h=f.input.portfolios[1].holdings[0];h.ticker='GLD';h.sourceAssetType='exchange_traded_fund';h.sourceInstrument={instrumentId:22272,instrumentCode:'GLD',market:'NYSE',currency:'USD'};change(h);
  const a=resolveAssetAllocation(f).assetAllocation;assert.equal(a.gold,0);assert.equal(a.equity+a.etf,300);
});
test('contradictory or untyped native security identity is rejected without a ticker fallback',()=>{
  for(const change of [h=>h.sourceInstrument.instrumentCode='OTHER',h=>h.sourceInstrument.instrumentId='22272',h=>h.sourceInstrument.currency='HKD',h=>h.sourceInstrument.extra=true]){
    const f=assetFixture(),h=f.input.portfolios[1].holdings[0];h.ticker='GLD';h.sourceAssetType='exchange_traded_fund';h.sourceInstrument={instrumentId:22272,instrumentCode:'GLD',market:'NYSE',currency:'USD'};change(h);assert.throws(()=>resolveAssetAllocation(f));
  }
});
for (const [name, change, code] of [
  ['wrong mode', f=>f.input.mode='anything', 'INPUT_DATE'],
  ['proposals cannot silently mutate history', f=>f.input.proposals=[{}], 'SCHEMA'],
  ['wrong source date', f=>f.input.portfolios[0].sourceDate='2026-09-03', 'SOURCE_DATE'],
  ['wrong account', f=>f.input.portfolios[0].portfolioId=999, 'ACCOUNT'],
  ['duplicate account', f=>f.input.portfolios[1]=structuredClone(f.input.portfolios[0]), 'ACCOUNT'],
  ['duplicate holding', f=>f.input.portfolios[0].holdings.push({...f.input.portfolios[0].holdings[0]}), 'HOLDING_DUPLICATE'],
  ['negative value', f=>f.input.portfolios[0].holdings[0].valueUsd=-1, 'AMOUNT'],
  ['coerced value', f=>f.input.portfolios[0].holdings[0].valueUsd='100', 'AMOUNT'],
  ['account sum missing', f=>f.input.portfolios[0].stockTotalUsd=102, 'ACCOUNT_STOCK_SUM'],
  ['global sum missing', f=>f.stock=302, 'ASSET_ALLOCATION'],
  ['type object', f=>f.input.portfolios[0].holdings[0].sourceAssetType={}, 'SCHEMA'],
  ['SGOV remains outside this legacy securities aggregate', f=>f.input.portfolios[0].holdings[0].ticker='SGOV', 'IDENTITY'],
]) test(`source asset mode still blocks ${name}`, () => {
  const f=assetFixture(); change(f); assert.throws(()=>resolveAssetAllocation(f), new RegExp('STYLE_'+code));
});
