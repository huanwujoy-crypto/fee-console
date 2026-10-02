import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeActionEvidence} from './data_quality.mjs';
const now=Date.parse('2026-10-05T06:00:00Z'),targetDate='2026-10-02',contract='c'.repeat(64),binding='b'.repeat(64);
const options={now,targetDate,approvedReadContracts:[contract]};
function fixture(){
 return{identity:{verified:true,basis:'machine-verified-current',bindingHash:binding,flexScopeMatches:true},
  live:Object.fromEntries(['positions','orders','trades','cash'].map(key=>[key,{accountBindingHash:binding,rawHash:'a'.repeat(64),contractHash:contract,
   allPagesRead:true,truncated:false,readAt:new Date(now).toISOString(),upstreamAsOf:null}])),
  coveredSession:Object.fromEntries(['trades','cash'].map(key=>[key,{source:'activity-flex',accountBindingHash:binding,rawHash:'d'.repeat(64),
   fromDate:targetDate,toDate:targetDate,whenGenerated:'2026-10-02T22:00:00Z',sectionComplete:true}])),
  cashBasis:'trade-date-by-currency-verified',consistency:{positionsAgainstTrades:'matched',cashAgainstCoveredLedger:'matched',allocationAgainstPositions:'matched',noahCash:'matched'}};
}
test('verified complete reads need no fabricated snapshot ID or upstream timestamp',()=>{
 const result=gradeActionEvidence(fixture(),options);
 assert.equal(result.actionAllowed,true);assert.equal(result.ledgerFinality,'not-certified');assert.equal(result.warnings.length,4);
});
test('trade confirmation and file update time cannot replace target-day Activity coverage',()=>{
 const e=fixture();delete e.coveredSession;e.tradeConfirmation={verified:true};e.fileUpdatedAt=new Date(now).toISOString();
 const result=gradeActionEvidence(e,options);assert.equal(result.actionAllowed,false);assert.ok(result.blockers.includes('TRADES_TARGET_SESSION_NOT_COVERED'));
});
test('absence of live orders permits only limited non-action, never zero buying reserve',()=>{
 const e=fixture();delete e.live.orders;
 const result=gradeActionEvidence(e,options);assert.equal(result.status,'limited-non-action');assert.equal(result.actionAllowed,false);
 assert.ok(result.warnings.includes('OPEN_BUY_RESERVE_UNKNOWN_NEVER_ASSUME_ZERO'));
});
test('unreviewed contract, incomplete page, stale read, scope conflict and cash basis deny action',()=>{
 for(const modify of [e=>e.identity.verified=false,e=>e.identity.basis='historical-attestation',e=>e.identity.flexScopeMatches=false,
  e=>e.live.positions.contractHash='f'.repeat(64),e=>e.live.positions.allPagesRead=false,e=>e.live.positions.truncated=true,
  e=>e.live.cash.readAt='2026-10-05T05:29:59Z',e=>e.live.orders.accountBindingHash='e'.repeat(64),
  e=>e.coveredSession.cash.toDate='2026-10-01',e=>e.consistency.cashAgainstCoveredLedger='conflict',
  e=>e.consistency.allocationAgainstPositions='unknown',e=>e.cashBasis='settled-cash',
  e=>e.live.positions.readAt='2026-10-05T05:50:00Z',e=>e.live.cash.upstreamAsOf='2026-10-05T05:00:00Z']){
  const e=fixture();modify(e);assert.equal(gradeActionEvidence(e,options).actionAllowed,false);
 }
});
test('generation age of a genuinely covered closed-session statement is not live-source freshness',()=>{
 const e=fixture();e.coveredSession.cash.whenGenerated='2026-10-02T22:00:00Z';
 assert.equal(gradeActionEvidence(e,options).actionAllowed,true);
 e.coveredSession.cash.toDate='2026-10-01';assert.equal(gradeActionEvidence(e,options).actionAllowed,false);
});
