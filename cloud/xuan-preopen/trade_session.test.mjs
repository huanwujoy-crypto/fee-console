import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNewYorkSession } from './trade_session.mjs';
test('summer NY session crosses UTC midnight, retaining previous session executions', () => {
  const trades = ['2026-10-01T03:59:59Z', '2026-10-01T04:00:00Z',
    '2026-10-02T00:10:00Z', '2026-10-02T04:00:00Z'].map(trade_time => ({ trade_time }));
  const result = selectNewYorkSession(trades, '2026-10-01');
  assert.deepEqual(result.selected, trades.slice(1, 3));
  assert.equal(result.coverageVerified, false);
  assert.equal(result.executionUniquenessVerified, false);
});
test('winter and European/US DST gap use NY IANA boundaries', () => {
  for (const [date, before, at] of [
    ['2026-11-03', '2026-11-03T04:59:59Z', '2026-11-03T05:00:00Z'],
    ['2026-10-27', '2026-10-27T03:59:59Z', '2026-10-27T04:00:00Z'],
  ]) assert.deepEqual(selectNewYorkSession([{ trade_time: before }, { trade_time: at }], date).selected,
    [{ trade_time: at }]);
});
test('empty response never proves zero executions; ambiguous timestamps reject', () => {
  assert.equal(selectNewYorkSession([], '2026-10-01').coverageVerified, false);
  for (const trade_time of ['2026-10-01 12:00:00', 1790900000, 'invalid'])
    assert.throws(() => selectNewYorkSession([{ trade_time }], '2026-10-01'), /ZONE_UNVERIFIED/);
});
