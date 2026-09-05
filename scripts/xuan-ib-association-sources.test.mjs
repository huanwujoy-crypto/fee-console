import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAssociationReceipt,
  createPreReadAssociationReceipt,
  associationPolicyBlob
} from './xuan-ib-account-association.mjs';
import {
  APPROVED_IB_ACCOUNT_ID, IB_ENDPOINTS, RUN_STAGES, fingerprint,
  validateManifest, validateSourceEvidence, assessSourceReadiness
} from './xuan-ib-run-manifest.mjs';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { getManualConsentRunId } from './xuan-ib-manual-consent.mjs';
import { buildSourceEvidence } from './xuan-ib-source-adapter.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url)));
const epoch = Date.parse('2026-09-05T03:00:00.000Z');
const now = epoch + 4_000;
const iso = offset => new Date(epoch + offset).toISOString();
const clock = offset => ({ wallNow: () => epoch + offset, monotonicNowMs: () => offset });
const clone = value => JSON.parse(JSON.stringify(value));
const prior = 'a'.repeat(40);
const policy = () => ({
  schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
  basis: 'owner-attested-recurring-v1', status: 'active',
  purpose: 'xuan-ib-read-only-report', editions: ['adhoc'], publisher: 'claude-verified-candidate-v1',
  validFrom: iso(-1_000), expiresAt: iso(7 * 86_400_000 - 1_000)
});
const snapshot = (offset = 900) => ({
  policy: policy(), policyCommit: 'b'.repeat(40), policyBlob: associationPolicyBlob(policy()), checkedAt: iso(offset)
});
const read = (raw, start, end) => ({ raw, status: 'ok', startedAt: iso(start),
  completedAt: iso(end), retries: 0, rawFingerprint: fingerprint(raw) });
const boundaries = {
  bootstrap: [100, 800], 'ib-read': [1_000, 1_900], 'sharesight-read': [2_000, 2_400],
  validate: [2_500, 2_600], derive: [2_700, 2_800], narrative: [2_900, 3_000],
  render: [3_100, 3_200], guard: [3_300, 3_400], 'candidate-prep': [3_500, 3_600]
};
function stages(journalPath, names, custom = boundaries, positionsFailed = false) {
  for (const name of names) {
    startJournalStage(journalPath, name, clock(custom[name][0]));
    finishJournalStage(journalPath, name, positionsFailed && name === 'ib-read'
      ? {status:'degraded',errorCode:'IB_POSITIONS_FALLBACK'} : {}, clock(custom[name][1]));
  }
}
function rawInput() {
  const raw = {
    accountSummary: { currency: 'USD', net_liquidation: 100, total_cash_value: 10 },
    balances: { balances: [] }, positions: { positions: [] }, orders: { orders: [] }, trades: { trades: [] }
  };
  return {
    edition: 'adhoc', dataDate: '2026-09-05', previousSourceSha: prior,
    ib: Object.fromEntries(IB_ENDPOINTS.map((name, index) => [name, read(raw[name], 1_100 + index * 100, 1_150 + index * 100)])),
    sharesight: registry.portfolios.filter(item => item.requiredEachReport).map(item => read({ result: {
      mode: 'read_only', portfolio: { id: item.portfolioId, currency_code: 'USD' },
      data: { report: { portfolio_id: item.portfolioId, value: 100, end_date: '2026-09-05',
        currency: { code: 'USD' }, holdings: [], cash_accounts: [] } }
    } }, 2_100, 2_200))
  };
}
async function fixture(t, custom = boundaries, positionsFailed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-association-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'journal.jsonl');
  initRunJournal(journalPath, clock(0));
  stages(journalPath, ['bootstrap'], custom);
  const associationReceipt = await createPreReadAssociationReceipt(snapshot(), {
    journalPath, now: epoch + 900, edition: 'adhoc', previousSourceSha: prior
  });
  stages(journalPath, RUN_STAGES.filter(name => name !== 'bootstrap'), custom, positionsFailed);
  const associationSnapshot = snapshot(4_000);
  const options = { associationReceipt, associationSnapshot, journalPath, now };
  return { journalPath, associationReceipt, associationSnapshot, options, input: rawInput() };
}
const context = fixture => ({ now, associationSnapshot: fixture.associationSnapshot,
  edition: 'adhoc', previousSourceSha: prior, runId: fixture.associationReceipt.runId });
function manifest(evidence, receipt) {
  const componentKeys = ['runtimeContractHash', 'scheduleContractHash', 'addendumHash', 'registryHash', 'mappingHash'];
  const components = Object.fromEntries(componentKeys.map(key => [key, fingerprint({ synthetic: key })]));
  return { schemaVersion: 1, runId: receipt.runId, edition: 'adhoc', dataDate: '2026-09-05',
    startedAt: iso(0), preparedAt: iso(4_000), previousSourceSha: prior,
    stages: RUN_STAGES.map(name => ({ name, startedAt: iso(boundaries[name][0]), endedAt: iso(boundaries[name][1]),
      durationMs: boundaries[name][1] - boundaries[name][0], cacheHit: false, status: 'ok' })),
    sources: evidence.sources, methods: { ...components, methodBundleHash: fingerprint(components) },
    inputFingerprint: fingerprint({ synthetic: true }) };
}

test('recurring association is explicit, source-preserving and independent of one-shot proof', async t => {
  const f = await fixture(t), original = clone(f.input);
  const evidence = buildSourceEvidence(f.input, registry, f.options);
  assert.deepEqual(f.input, original);
  assert.equal(evidence.sources.ib.accountScopeBasis, 'owner-attested-recurring-v1');
  assert.deepEqual(evidence.sources.ib.accountAssociation, f.associationReceipt);
  assert.equal(Object.hasOwn(evidence.sources.ib, 'manualConsent'), false);
  assert.equal(Object.hasOwn(f.input.ib.accountSummary.raw, 'account_id'), false);
  assert.equal(JSON.stringify(f.associationReceipt).includes(APPROVED_IB_ACCOUNT_ID), false);
  for (const name of IB_ENDPOINTS) {
    assert.equal(evidence.sources.ib[name].fingerprint, fingerprint(f.input.ib[name].raw));
    assert.equal(evidence.sources.ib[name].readStartedAt, f.input.ib[name].startedAt);
  }
  assert.equal(evidence.sources.sharesight.length, 9);
  for (const source of evidence.sources.sharesight) assert.equal(source.readStartedAt, iso(2_100));
  assert.equal(f.input.ib.accountSummary.raw.total_cash_value, 10);
  assert.equal(f.input.sharesight.find(item => item.raw.result.portfolio.id === 936240).raw.result.data.report.value, 100);
});

test('live source association requires a fresh active same-policy snapshot and exact run context', async t => {
  const f = await fixture(t);
  for (const change of [
    { associationSnapshot: null }, { associationReceipt: null }, { journalPath: null },
    { associationSnapshot: { ...f.associationSnapshot, policyBlob: 'd'.repeat(40) } },
    { associationSnapshot: { ...f.associationSnapshot, checkedAt: iso(-60_001) } },
    { associationReceipt: { ...f.associationReceipt, runId: 'd'.repeat(64) } },
    { manualConsentProof: { synthetic: true } }
  ]) assert.throws(() => buildSourceEvidence(f.input, registry, { ...f.options, ...change }));
  for (const status of ['inactive', 'revoked']) {
    const altered = clone(f.associationSnapshot); altered.policy.status = status;
    if (status === 'inactive') { altered.policy.validFrom = null; altered.policy.expiresAt = null; }
    altered.policyBlob = associationPolicyBlob(altered.policy);
    assert.throws(() => buildSourceEvidence(f.input, registry, { ...f.options, associationSnapshot: altered }), /inactive|revoked/);
  }
  for (const change of [{ edition: 'pm' }, { previousSourceSha: 'e'.repeat(40) }]) {
    assert.throws(() => buildSourceEvidence({ ...f.input, ...change }, registry, f.options));
  }
});

test('present bad, null or empty account identifiers reject owner-attested and native paths', async t => {
  const f = await fixture(t);
  for (const bad of [null, '', 'SYNTHETIC_OTHER']) {
    for (const endpoint of IB_ENDPOINTS) {
      for (const key of ['account_id', 'accountId']) {
        const input = clone(f.input);
        input.ib[endpoint].raw.items = [{ nested: { [key]: bad } }];
        input.ib[endpoint].rawFingerprint = fingerprint(input.ib[endpoint].raw);
        assert.throws(() => buildSourceEvidence(input, registry, f.options), /ACCOUNT_SCOPE_MISMATCH/);
        input.ib.accountSummary.raw.account_id = APPROVED_IB_ACCOUNT_ID;
        input.ib.accountSummary.rawFingerprint = fingerprint(input.ib.accountSummary.raw);
        assert.throws(() => buildSourceEvidence(input, registry), /ACCOUNT_SCOPE_MISMATCH/);
      }
    }
    const input = clone(f.input); input.ib.accountSummary.raw.account_id = bad;
    assert.throws(() => buildSourceEvidence(input, registry, f.options), /ACCOUNT_SCOPE_UNPROVEN/);
  }
  const nested = clone(f.input); nested.ib.accountSummary.raw.nested = { account_id: APPROVED_IB_ACCOUNT_ID };
  nested.ib.accountSummary.rawFingerprint = fingerprint(nested.ib.accountSummary.raw);
  assert.throws(() => buildSourceEvidence(nested, registry), /ACCOUNT_SCOPE_UNPROVEN/);
  const native = clone(f.input); native.ib.accountSummary.raw.account_id = APPROVED_IB_ACCOUNT_ID;
  native.ib.accountSummary.rawFingerprint = fingerprint(native.ib.accountSummary.raw);
  assert.throws(() => buildSourceEvidence(native, registry, f.options), /ASSOCIATION_EVIDENCE_WITH_NATIVE_ID/);
});

test('pre-read association must follow bootstrap and strictly precede both financial stages', async t => {
  const f = await fixture(t);
  for (const offset of [700, 1_000, 2_050]) {
    const associationReceipt = createAssociationReceipt(snapshot(offset), {
      now: epoch + offset, edition: 'adhoc', previousSourceSha: prior, runId: getManualConsentRunId(f.journalPath)
    });
    assert.throws(() => buildSourceEvidence(f.input, registry, { ...f.options, associationReceipt }), /ASSOCIATION_NOT_BEFORE_FINANCIAL_READS/);
  }
  const input = clone(f.input); input.ib.orders.startedAt = iso(999);
  assert.throws(() => buildSourceEvidence(input, registry, f.options), /ASSOCIATION_READ_OUTSIDE_JOURNAL/);
  const ss = clone(f.input); ss.sharesight[0].startedAt = iso(1_999);
  assert.throws(() => buildSourceEvidence(ss, registry, f.options), /ASSOCIATION_SHARESIGHT_READ_OUTSIDE_JOURNAL/);
});

test('historical manifests validate strict recorded context without asserting current authorization', async t => {
  const f = await fixture(t), evidence = buildSourceEvidence(f.input, registry, f.options);
  const historical = manifest(evidence, f.associationReceipt);
  assert.equal(validateManifest(historical, registry), historical);
  assert.equal(validateManifest(historical, registry, { associationSnapshot: f.associationSnapshot, now }), historical);
  for (const change of [{ runId: 'e'.repeat(64) }, { previousSourceSha: 'e'.repeat(40) }, { edition: 'pm' }]) {
    assert.throws(() => validateManifest({ ...historical, ...change }, registry));
  }
  const badStage = clone(historical); badStage.stages.find(stage => stage.name === 'sharesight-read').startedAt = iso(900);
  badStage.stages.find(stage => stage.name === 'sharesight-read').durationMs = 1_500;
  assert.throws(() => validateManifest(badStage, registry), /precede both financial read stages/);
  const preCheck = clone(historical); preCheck.sources.sharesight[0].readStartedAt = iso(900);
  assert.throws(() => validateManifest(preCheck, registry), /does not follow the pre-read check/);
  const expired = clone(f.associationSnapshot); expired.policy.expiresAt = iso(3_000);
  expired.policyBlob = associationPolicyBlob(expired.policy);
  assert.throws(() => validateManifest(historical, registry, { associationSnapshot: expired, now }), /expired/);
  assert.equal(validateManifest(historical, registry), historical);
});

test('all five IB and nine Sharesight source receipts remain mandatory and within validity', async t => {
  const f = await fixture(t), evidence = buildSourceEvidence(f.input, registry, f.options);
  for (const endpoint of IB_ENDPOINTS) {
    const sources = clone(evidence.sources); delete sources.ib[endpoint].readStartedAt;
    assert.throws(() => validateSourceEvidence(sources, registry, context(f)), /readStartedAt/);
  }
  for (const mutate of [
    x => x.sharesight.pop(), x => x.sharesight.push(x.sharesight[0]),
    x => { delete x.sharesight[0].readStartedAt; },
    x => { x.sharesight[0].readStartedAt = iso(900); },
    x => { x.ib.positions.asOf = f.associationSnapshot.policy.expiresAt; },
    x => { x.sharesight[0].asOf = f.associationSnapshot.policy.expiresAt; },
    x => { x.ib.orders.asOf = iso(4_001); }
  ]) {
    const sources = clone(evidence.sources); mutate(sources);
    assert.throws(() => validateSourceEvidence(sources, registry, context(f)));
  }
  assert.throws(() => validateSourceEvidence(evidence.sources, registry, { ...context(f), now: undefined }), /explicit clock/);
  const mixed = clone(evidence.sources); mixed.ib.manualConsent = { synthetic: true };
  assert.throws(() => validateSourceEvidence(mixed, registry, context(f)), /mixed account scope/);
  const raw = clone(f.input); raw.ib.positions.raw.positions.push({ synthetic: true });
  assert.throws(() => buildSourceEvidence(raw, registry, f.options), /RAW_CHANGED_SINCE_CAPTURE/);
});

async function fallbackFixture(t, { lag = 1, status = 'failed' } = {}) {
  const f = await fixture(t, boundaries, true);
  f.input.ib.positions = {...read({isError:true,error:{code:'SYNTHETIC_UNAVAILABLE'}},1_300,1_350),
    status,retries:1,errorCode:'SERVICE_UNAVAILABLE'};
  const ibHk = f.input.sharesight.find(item => item.raw.result.portfolio.id === 936247);
  if(lag !== undefined) ibHk.completedUsTradingDayLag = lag;
  return f;
}

test('recurring failed positions preserve the approved fresh Sharesight fallback without inventing a quote', async t => {
  for (const status of ['failed','unavailable']) {
    const f = await fallbackFixture(t,{status}), original=clone(f.input);
    const evidence=buildSourceEvidence(f.input,registry,f.options);
    assert.deepEqual(f.input,original);
    assert.deepEqual(evidence.sources.ib.positions,{
      status,asOf:null,retries:1,fingerprint:null,errorCode:'SERVICE_UNAVAILABLE',
      readStartedAt:iso(1_300),attemptCompletedAt:iso(1_350)
    });
    const readiness=assessSourceReadiness(evidence.sources,registry,context(f));
    assert.equal(readiness.positionSource,'sharesight-ib-hk');
    assert.equal(readiness.blocked,false);
    assert.equal(readiness.degraded,true);
    const historical=manifest(evidence,f.associationReceipt);
    historical.stages.find(stage=>stage.name==='ib-read').status='degraded';
    assert.equal(validateManifest(historical,registry),historical);
    const fakeOk=clone(historical);fakeOk.stages.find(stage=>stage.name==='ib-read').status='ok';
    assert.throws(()=>validateManifest(fakeOk,registry),/contradict direct\/fallback/);
  }
});

test('recurring positions fallback never excuses missing attempts, stale lag or critical failure', async t => {
  const f=await fallbackFixture(t);
  for(const lag of [undefined,2,30,-1,1.5,'1']){
    const input=clone(f.input),ibHk=input.sharesight.find(item=>item.raw.result.portfolio.id===936247);
    if(lag===undefined)delete ibHk.completedUsTradingDayLag;else ibHk.completedUsTradingDayLag=lag;
    assert.throws(()=>buildSourceEvidence(input,registry,f.options),/FALLBACK/);
  }
  for(const change of [
    {raw:{positions:[]}}, {raw:{synthetic:'shape_missing'}}, {rawFingerprint:'d'.repeat(64)},
    {startedAt:iso(999)}, {completedAt:iso(1_901)}, {errorCode:'uncensored human error'}, {retries:6}
  ]){
    const input=clone(f.input);Object.assign(input.ib.positions,change);
    if(Object.hasOwn(change,'raw'))input.ib.positions.rawFingerprint=fingerprint(input.ib.positions.raw);
    assert.throws(()=>buildSourceEvidence(input,registry,f.options));
  }
  for(const endpoint of ['accountSummary','balances','orders','trades']){
    const input=clone(f.input);input.ib[endpoint]=clone(input.ib.positions);
    assert.throws(()=>buildSourceEvidence(input,registry,f.options));
  }
  const direct=await fixture(t);
  assert.throws(()=>buildSourceEvidence(f.input,registry,{...f.options,journalPath:direct.journalPath}),/ASSOCIATION_READ_STAGE_INCOMPLETE/);
  const evidence=buildSourceEvidence(f.input,registry,f.options);
  for(const change of [{attemptCompletedAt:iso(4_001)},{attemptCompletedAt:f.associationSnapshot.policy.expiresAt},{asOf:iso(1_350)},{fingerprint:'a'.repeat(64)}]){
    const sources=clone(evidence.sources);Object.assign(sources.ib.positions,change);
    assert.throws(()=>validateSourceEvidence(sources,registry,context(f)));
  }
  const missing=clone(evidence.sources);delete missing.ib.positions.attemptCompletedAt;
  assert.throws(()=>validateSourceEvidence(missing,registry,context(f)),/attemptCompletedAt/);
  const overreach=clone(evidence.sources);overreach.ib.orders={...overreach.ib.positions};
  assert.throws(()=>validateSourceEvidence(overreach,registry,context(f)),/unknown field attemptCompletedAt/);
});
