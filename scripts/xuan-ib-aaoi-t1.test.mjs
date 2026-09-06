import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAaoiT1} from './xuan-ib-aaoi-t1.mjs';
const fixture=()=>({symbol:'AAOI',portfolioId:'1350094',holdingId:'28656360',instrumentId:'523742',currency:'USD',marketValueUsd:10553,valueDate:'2026-09-05'});
test('AAOI explicit T1 uses existing coefficients and deterministic one-notice identity',()=>{
 const value=calculateAaoiT1(fixture());
 assert.deepEqual([value.low,value.mid,value.high],[6331.8,8442.4,10553]);
 assert.equal(value.notifyId,calculateAaoiT1({...fixture(),marketValueUsd:10600,valueDate:'2026-09-06'}).notifyId);
});
test('AAOI missing identity, currency, date or value cannot become zero or an assignment',()=>{
 for(const [key,value] of [['holdingId','other'],['instrumentId','other'],['currency','HKD'],['marketValueUsd',null],['marketValueUsd',-1],['marketValueUsd',1.001],['valueDate','2026-02-30']])
 assert.throws(()=>calculateAaoiT1({...fixture(),[key]:value}));
});
