import test from 'node:test';import assert from 'node:assert/strict';import {attemptFor,attemptPrefix} from './attempts.mjs';import {planPreopen} from './calendar.mjs';
test('three finite immutable namespaces, at T0/10/20, open excludes retries',()=>{
 const plan=planPreopen(Date.parse('2026-10-05T06:00:00Z'));
 for(const [seconds,attempt] of [[0,0],[599,0],[600,1],[1199,1],[1200,2],[3599,2]]){assert.equal(attemptFor(plan,plan.startEpoch*1000+seconds*1000),attempt);assert.ok(attemptPrefix(plan,attempt).startsWith(`delivery/${plan.dataDate}/${plan.slotId}/`));}
 for(const seconds of [-1,3600])assert.throws(()=>attemptFor(plan,plan.startEpoch*1000+seconds*1000),/OUTSIDE_WINDOW/);
 for(const attempt of [-1,3,1.5])assert.throws(()=>attemptPrefix(plan,attempt),/INVALID/);
});
