import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {DEFAULT_TOP10_POLICY} from './xuan-weekly-concentration.mjs';
import {DEFAULT_POLICY,buildAiExposure} from './xuan-weekly-ai-exposure.mjs';
const reviewed=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-etf-source-evidence/priority-business-reviewed-20261004.json',import.meta.url)));
const source=(symbol,type='ETF')=>({portfolioId:'synthetic',holdingId:'test',instrumentId:'test',symbol,assetType:type,custodian:'Synthetic',identityVerified:true,valueDate:'2026-10-02',marketValueMicro:'100000000'});
const run=(r,policy)=>buildAiExposure({riskConstituents:[r],riskDenominator:{components:[{key:'a',valueMicro:'80000000'},{key:'b',valueMicro:'10000000'},{key:'c',valueMicro:'10000000'}]}},{cutoff:'2026-10-02',policy});
test('every new business decision binds an exact existing dated equity identity, never a nested fund',()=>{
 assert.equal(reviewed.length,27);assert.equal(new Set(reviewed.map(d=>d.key)).size,27);
 for(const d of reviewed){const s=DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol===d.identityEvidence.fund);assert.equal(s.asOf,d.identityEvidence.asOf);const h=s.holdings.find(h=>h.issuerKey===d.key);assert.ok(h);assert.notEqual(h.kind,'nested-etf');if(d.identityEvidence.isin){const a=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-etf-source-evidence/'+s.symbol+'-20260924-audit.json',import.meta.url)));const rows=a.filter(r=>r.isin===d.identityEvidence.isin);assert.equal(rows.length,1);assert.equal(rows[0].issueName,d.identityEvidence.sourceName);assert.equal(rows[0].ticker,d.identityEvidence.sourceTicker);}else assert.equal(d.identityEvidence.legacySourceKey,d.key);assert.match(d.source,/^https:\/\//);}
});
test('explicit new issuer evidence resolves only its ETF part; unknown identities and direct ticker-only rows remain unknown',()=>{
 for(const d of reviewed){const p=structuredClone(DEFAULT_POLICY);p.etfSnapshots=[{instrumentId:'test',symbol:'TEST',fundName:'Synthetic',basis:'physical-holdings',asOf:'2026-09-24',source:'https://issuer.example/',sourceCompositionComplete:true,holdings:[{issuerKey:d.key,weightBp:4000},{issuerKey:'still-unknown',weightBp:6000}]}];const a=run(source('TEST'),p);assert.equal(a.groups.find(g=>g.key===d.group).marketValueCents,'4000');assert.equal(a.groups.find(g=>g.key==='etfUncovered').marketValueCents,'6000');assert.equal(run(source(d.identityEvidence.sourceTicker,'STK'),p).groups.find(g=>g.key==='pending').marketValueCents,'10000');}
});
test('nested ETF, stale and expired business reviews remain unknown',()=>{
 for(const key of ['unreviewed-isin-DE000A0Q4R85'])assert.equal(DEFAULT_POLICY.underlyingIssuers.some(d=>d.key===key),false);
 const d=reviewed[0],p=structuredClone(DEFAULT_POLICY);p.etfSnapshots=[{instrumentId:'test',symbol:'TEST',fundName:'Synthetic',basis:'physical-holdings',asOf:'2026-09-24',source:'https://issuer.example/',holdings:[{issuerKey:d.key,weightBp:10000}]}];p.reviewedOn='2026-09-01';p.reviewBy='2026-10-01';assert.equal(run(source('TEST'),p).groups.find(g=>g.key==='etfUncovered').marketValueCents,'10000');p.reviewBy='2027-01-04';p.etfSnapshots[0].asOf='2026-03-31';assert.equal(run(source('TEST'),p).groups.find(g=>g.key==='etfUncovered').marketValueCents,'10000');
});

test('MXUS replaces the whole top-ten date, retaining incomplete composition and the prior version',()=>{const s=DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol==='MXUS');assert.equal(s.asOf,'2026-09-30');assert.equal(s.basis,'economic-exposure');assert.equal(s.sourceCompositionComplete,false);assert.equal(s.holdings.length,10);assert.equal(s.holdings.reduce((n,h)=>n+h.weightBp,0),3819);assert.equal(s.sourceHistory[0].asOf,'2026-08-31');assert.equal(s.sourceHistory[0].holdings.reduce((n,h)=>n+h.weightBp,0),3691);assert.equal(run(source('MXUS'),DEFAULT_POLICY).rows[0].etfAsOf,null);});

test('risk allocation and concentration use the same whole MXUS date and source weights',()=>{
 const a=DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol==='MXUS'),c=DEFAULT_TOP10_POLICY.funds.find(s=>s.symbol==='MXUS');
 assert.equal(c.asOf,a.asOf);assert.equal(c.source,a.source);assert.equal(c.sourceSha256,a.sourceSha256);
 assert.deepEqual(c.topTen.map(x=>x[1]),a.holdings.map(x=>x.weightBp));assert.equal(c.sourceCompositionComplete,false);
 const r=run({...source('MXUS'),instrumentId:'391602'},DEFAULT_POLICY);assert.equal(r.rows[0].etfAsOf,'2026-09-30');assert.equal(r.rows[0].uncoveredCents,'6181');
});
