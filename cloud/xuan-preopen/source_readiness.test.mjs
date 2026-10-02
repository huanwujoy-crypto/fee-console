import test from 'node:test';
import assert from 'node:assert/strict';
import {assessIbReadiness, IB_READINESS_KEYS} from './source_readiness.mjs';
const now = Date.parse('2026-10-05T06:00:00Z'), sourceDate = '2026-10-02';
const fixture = () => IB_READINESS_KEYS.map(sourceKey => ({sourceKey, startedAt: new Date(now).toISOString(),
  completedAt: new Date(now).toISOString(), raw: {coverage: {origin:'IBKR',schemaVersion:1,complete:true,
    paginationComplete:true,targetTradeDate:sourceDate,coveredThroughDate:sourceDate,asOf:new Date(now).toISOString(),snapshotId:'synthetic'}}}));
test('local acquisition time and empty trade lists do not prove upstream coverage', () => {
  const sources = fixture(); for (const s of sources) s.raw = {trades:[]};
  const result = assessIbReadiness(sources, {sourceDate,now});
  assert.equal(result.status,'data-not-ready'); assert.equal(result.issues.length,4);
});
test('contract checks require every IB source and consistent upstream snapshots', () => {
  assert.equal(assessIbReadiness(fixture(), {sourceDate,now}).status,'ready');
  for (const modify of [s=>s.pop(),s=>s.push(s[0]),s=>s[1].raw.coverage.snapshotId='conflict',
    s=>s[3].raw.coverage.targetTradeDate='2026-10-01',s=>s[0].raw.coverage.complete=false,
    s=>s[3].raw.coverage.paginationComplete=false,s=>s[2].raw.coverage.coveredThroughDate='2026-10-01',
    s=>s[0].raw.coverage.asOf='2026-10-05T05:29:59Z',s=>s[0].raw.coverage.asOf='2026-10-05T06:00:01Z']) {
    const sources = fixture(); modify(sources);
    assert.equal(assessIbReadiness(sources, {sourceDate,now}).status,'data-not-ready');
  }
});
