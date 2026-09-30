import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {publishPrepared} from './publish.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {associationPolicyBlob, createAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
const now = () => Date.parse('2026-10-01T05:01:00Z');
function fixture() {
  const policy = {schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK', basis: 'owner-attested-recurring-v1',
    status: 'active', purpose: 'xuan-ib-read-only-report', editions: ['adhoc','am','pm'], publisher: 'codex-verified-candidate-v1',
    validFrom: '2026-09-11T13:30:00.000Z', expiresAt: '2026-10-10T13:30:00.000Z'};
  const association = {policy, policyCommit: 'a'.repeat(40), policyBlob: associationPolicyBlob(policy), checkedAt: new Date(now()).toISOString()};
  const context = {association, previousSourceSha: 'c'.repeat(40), reserveLedger: {schemaVersion: 1,
    purpose: 'xuan-etf-owner-declared-pending-calls', entries: [{date: '2026-09-17', usd: 400}]}};
  const model = {schemaVersion: 5, dataDate: '2026-10-01', status: 'ready', asOfHkt: '2026-10-01 13:01 HKT · 数据至 2026-09-30',
    replenishment: {status: 'ready', total: 600, budget: 800, retained: 200, items: [{symbol: 'EXUS', amount: 600}]},
    orders: {status: 'ready', asOfHkt: '13:01 HKT', buys: [], sells: []},
    cash: {status: 'ready', ib: 700, noah: 300, pool: 1000, reserve: 400, callApplied: 200, planning: 800,
      orderReserve: 0, cashLike: {total: 0, items: []}, totalCapacity: 800},
    allocation: {status: 'ready', total: 1000, projectedTotal: 1000, categories: ['美国底仓','美国科技','非美发达','新兴市场'].map(label =>
      ({label, marketValue: 250, projectedMarketValue: 250, currentPct: 25, projectedPct: 25, targetPct: 25}))}, notes: []};
  const html = renderNightActionReport(model);
  const receipt = {schemaVersion: 1, mode: 'private_report_check', status: 'ready', dataDate: model.dataDate, sourceDate: '2026-09-30',
    startedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString(), publication: 'none', sourceCount: 5,
    sources: ['ib.accountSummary','ib.positions','ib.orders','sharesight.ibGroupedPerformance','sharesight.noahPerformance'].map(sourceKey => ({sourceKey, sha256: 'f'.repeat(64)})),
    association: createAssociationReceipt(association, {now: now(), edition: 'am', previousSourceSha: context.previousSourceSha, runId: 'b'.repeat(64)}),
    artifact: {sha256: crypto.createHash('sha256').update(html).digest('hex')}};
  const calls = [];
  const request = async payload => {
    calls.push(payload);
    if (payload.query.startsWith('query')) return {data: {viewer: {login: 'huanwujoy-crypto'}, repository: {id: 'repo', ref: {target: {oid: 'a'.repeat(40)}}}}};
    if (payload.query.includes('CreateRef')) return {data: {createRef: {ref: {name: payload.variables.input.name, target: {oid: 'a'.repeat(40)}}}}};
    return {data: {createCommitOnBranch: {commit: {oid: 'd'.repeat(40)}, ref: {name: payload.variables.input.branch.branchName}}}};
  };
  return {html, receipt, request, loadContext: async () => structuredClone(context), now, calls, context};
}
test('publisher creates only one signed index.html candidate; it never edits main/latest metadata', async () => {
  const f = fixture(), result = await publishPrepared(f);
  assert.match(result.branch, /^codex\/xuan-ib-preopen-20261001-[a-f0-9]{6}$/);
  assert.equal(result.publication, 'candidate-only'); assert.equal(f.calls.length, 3);
  const input = f.calls[2].variables.input;
  assert.equal(input.expectedHeadOid, 'a'.repeat(40)); assert.equal(input.message.headline, 'handover 2026-10-01');
  assert.deepEqual(input.fileChanges.additions.map(a => a.path), ['xuan-ib/index.html']);
  assert.equal(Buffer.from(input.fileChanges.additions[0].contents,'base64').toString(), f.html);
});
test('tampering, stale generation, incomplete sources and partial reports make no GitHub writes', async () => {
  for (const change of [f => f.html += 'tamper', f => f.receipt.startedAt = '2026-10-01T04:00:00Z',
    f => f.receipt.sources[1] = f.receipt.sources[0], f => f.receipt.status = 'partial', f => f.receipt.dataDate = '2026-09-30']) {
    const f = fixture(); change(f); await assert.rejects(publishPrepared(f)); assert.equal(f.calls.length, 0);
  }
});
test('reserve changes, expired associations and source-base changes cannot publish', async () => {
  for (const change of [c => c.reserveLedger.entries[0].usd = 401, c => c.previousSourceSha = 'e'.repeat(40),
    c => {c.association.policy.expiresAt = '2026-09-30T13:30:00Z'; c.association.policyBlob = associationPolicyBlob(c.association.policy);}]) {
    const f = fixture(); change(f.context); await assert.rejects(publishPrepared(f)); assert.equal(f.calls.length, 0);
  }
});
test('non-owner or changed main is rejected before creating the candidate branch', async () => {
  for (const login of ['someone-else','huanwujoy-crypto']) {
    const f = fixture(); f.request = async () => ({data: {viewer: {login}, repository: {id: 'repo', ref: {target: {oid: 'e'.repeat(40)}}}}});
    await assert.rejects(publishPrepared(f), /OWNER|BASE_CHANGED/);
  }
});
test('a concurrent base change after branch creation does not write a report commit', async () => {
  const f = fixture(); let reads = 0;
  f.loadContext = async () => {const c = structuredClone(f.context); if (++reads === 2) c.association.policyCommit = 'e'.repeat(40); return c;};
  await assert.rejects(publishPrepared(f), /BASE_CHANGED/); assert.equal(f.calls.length, 2);
});
