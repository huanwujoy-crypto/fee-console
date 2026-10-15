// SYNTHETIC owner declarations only. No account data or external reads.
import test from 'node:test';import assert from 'node:assert/strict';
import {resolveCurrentCall,callDeclarationSha256} from './call_record.mjs';
const ledger=entries=>({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries});
test('owner-provided CALL persists without external reads, daily freshness or extra confirmation',()=>{
  const entry={date:'2026-09-17',usd:120},l=ledger([entry]);
  for(const day of ['2026-10-15','2026-10-16','2027-03-01'])assert.deepEqual(resolveCurrentCall(l,day),{status:'owner-declared',declarationDate:entry.date,declarationSha256:callDeclarationSha256(entry),amountUsd:120});
});
test('a new dated owner entry changes the level from that date, including an explicit zero',()=>{
  const l=ledger([{date:'2026-09-17',usd:120},{date:'2026-10-16',usd:0}]);
  assert.equal(resolveCurrentCall(l,'2026-10-15').amountUsd,120);assert.equal(resolveCurrentCall(l,'2026-10-16').amountUsd,0);
});
test('missing, invalid or future-only declarations do not invent an amount',()=>{
  for(const l of [undefined,ledger([]),ledger([{date:'2026-10-17',usd:120}]),ledger([{date:'invalid',usd:120}]),ledger([{date:'2026-09-17',usd:-1}]),ledger([{date:'2026-09-17',usd:120},{date:'2026-09-17',usd:130}])])assert.equal(resolveCurrentCall(l,'2026-10-16').amountUsd,null);
});
