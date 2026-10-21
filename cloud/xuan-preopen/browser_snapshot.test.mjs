import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBrowserSnapshot,SHARESIGHT_BROWSER_SOURCE} from './eod_sources.mjs';
import {readVerifiedSnapshot,digest} from './eod_sources.mjs';
import {buildBookConcentration} from '../../scripts/xuan-ib-eod-holdings.mjs';
globalThis.fetch=()=>assert.fail('Offline only');
const date='2026-10-20',scope={portfolioId:936247,sourceDate:date};
function fixture(){return {mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,observation:{portfolio:'IB-HK',valuationDate:date,retrievedAt:'2026-10-21T02:24:11Z',reportingCurrency:'USD',portfolioValue:170,
 positions:[{instrument:'SYNTH | TEST',price:7.25,priceCurrency:'CAD',quantity:10,marketValueUSD:70,sourcePath:'/holdings/1',priceDate:null}],
 cash:[{name:'Synthetic',marketValueUSD:100,sourcePath:'/cash_accounts/1',nativeCurrency:'CAD',nativeBalance:140}]},classification:null};}
test('browser row values and native currencies remain distinct; original observation time is never refreshed',async()=>{
 const raw=fixture(),s=await readVerifiedSnapshot('sharesight.ibGroupedPerformance',{reader:async()=>({raw}),sourceDate:date,now:()=>Date.parse('2026-10-21T02:25:00Z')});
 assert.equal(s.status,'date-verified');assert.equal(s.provenance.readAt,'2026-10-21T02:24:11.000Z');assert.equal(s.provenance.syncCompletedAt,null);
 assert.equal(s.raw.source,SHARESIGHT_BROWSER_SOURCE);assert.equal(s.raw.data.report.holdings[0].value,70);assert.equal(s.raw.data.report.cash_accounts[0].currency.code,'CAD');
 assert.equal(s.raw.data.report.holdings[0].group_name,'');assert.equal(s.rawFingerprint,digest(s.raw));
 const c=buildBookConcentration(s,date);assert.equal(c.status,'ready');assert.equal(c.total,170);assert.equal(c.rows[0].currency,'CAD');
});
test('browser scope, total, duplicate identities, unrecognized currency and future capture fail closed',async()=>{
 for(const change of [o=>o.portfolio='OTHER',o=>o.valuationDate='2026-10-19',o=>o.portfolioValue++,o=>o.positions.push({...o.positions[0]}),o=>o.cash.push({...o.cash[0]}),o=>o.cash[0].nativeCurrency='unknown',o=>o.positions[0].priceCurrency='unknown']){
  const raw=fixture();change(raw.observation);assert.throws(()=>normalizeBrowserSnapshot(raw,scope));
 }
 const raw=fixture();const s=await readVerifiedSnapshot('sharesight.ibGroupedPerformance',{reader:async()=>({raw}),sourceDate:date,now:()=>Date.parse('2026-10-21T02:00:00Z')});assert.equal(s.status,'malformed');
});
