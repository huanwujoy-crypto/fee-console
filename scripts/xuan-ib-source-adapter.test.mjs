import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APPROVED_IB_ACCOUNT_ID, fingerprint } from './xuan-ib-run-manifest.mjs';
import { unwrapSource, normalizePositions, sourceRecordFromRaw, buildSourceEvidence } from './xuan-ib-source-adapter.mjs';
const registry=JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json',import.meta.url)));
const receipt=raw=>({raw,status:'ok',startedAt:'2026-09-05T02:00:00Z',completedAt:'2026-09-05T02:00:01Z',retries:0,rawFingerprint:fingerprint(raw)});
const ss=id=>({result:{mode:'read_only',portfolio:{id,currency_code:'USD'},data:{report:{portfolio_id:id,value:100,end_date:'2026-09-05',currency:{code:'USD'},holdings:[],cash_accounts:[]},api_transaction:{id:'synthetic'}}}});
const fixture=()=>({edition:'adhoc',dataDate:'2026-09-05',previousSourceSha:'a'.repeat(40),ib:{
  accountSummary:receipt({account_id:APPROVED_IB_ACCOUNT_ID,currency:'USD',net_liquidation:100,total_cash_value:10}),
  balances:receipt({balances:[]}),positions:receipt({positions:[]}),orders:receipt({orders:[]}),trades:receipt({trades:[]})},
  sharesight:registry.portfolios.filter(p=>p.requiredEachReport).map(p=>receipt(ss(p.portfolioId)))});
test('raw-source evidence preserves original response hashes and completion times',()=>{
  const input=fixture(),before=JSON.stringify(input),evidence=buildSourceEvidence(input,registry);
  assert.equal(evidence.sources.ib.positions.fingerprint,fingerprint(input.ib.positions.raw));
  assert.equal(evidence.sources.ib.positions.asOf,input.ib.positions.completedAt);
  assert.equal(evidence.sources.sharesight[0].fingerprint,fingerprint(input.sharesight[0].raw));
  assert.equal(JSON.stringify(input),before);
  input.sharesight[0].raw.result.data.api_transaction.id='other';
  assert.throws(()=>buildSourceEvidence(input,registry),/RAW_CHANGED_SINCE_CAPTURE/);
});
test('missing account ID cannot become confirmed from an approved constant or matching totals',()=>{
  const input=fixture();delete input.ib.accountSummary.raw.account_id;
  assert.throws(()=>buildSourceEvidence(input,registry),/ACCOUNT_SCOPE_UNPROVEN/);
  input.ib.accountSummary.raw.account_id='SYNTHETIC_OTHER';assert.throws(()=>buildSourceEvidence(input,registry),/ACCOUNT_SCOPE_UNPROVEN/);
  input.ib.accountSummary.raw.account_id=APPROVED_IB_ACCOUNT_ID;input.ib.positions.raw.account_id='SYNTHETIC_OTHER';
  assert.throws(()=>buildSourceEvidence(input,registry),/ACCOUNT_SCOPE_MISMATCH/);
});
test('missing, duplicate, mismatched or excluded portfolios fail closed',()=>{
  for(const mutate of [x=>x.sharesight.pop(),x=>x.sharesight.push(x.sharesight[0]),x=>{x.sharesight[0].raw.result.portfolio.id=1;},x=>{x.sharesight[0].raw.result.data.report.portfolio_id=1;}]){
    const input=fixture();mutate(input);assert.throws(()=>buildSourceEvidence(input,registry));
  }
});
test('normalization never fabricates USD values, quote changes, or converts strings to numbers',()=>{
  const raw={positions:[{contract_description:'TEST @SYNTHETIC',position:2,market_price:10,market_value:20,currency:'EUR'}]};
  assert.deepEqual(normalizePositions(raw),[{description:'TEST @SYNTHETIC',quantity:2,price:10,marketValueNative:20,currency:'EUR',changePct:null,quoteStatus:'unavailable'}]);
  raw.positions[0].market_value='20';assert.throws(()=>normalizePositions(raw),/INVALID_POSITION/);
});
test('failed reads, invalid source shapes and invalid clock receipts are rejected',()=>{
  assert.throws(()=>unwrapSource('positions',{positions:null}));
  assert.throws(()=>unwrapSource('orders',{orders:[],isError:true}));
  assert.throws(()=>unwrapSource('accountSummary',{currency:null,net_liquidation:100,total_cash_value:1}));
  const bad=ss(1);bad.result.portfolio.currency_code=null;bad.result.data.report.currency.code=null;
  assert.throws(()=>unwrapSource('sharesight',bad),/CURRENCY_OR_VALUE_MISMATCH/);
  for(const change of [{status:'failed'},{completedAt:'2026-09-05T01:00:00Z'},{startedAt:'yesterday'},{retries:6}]){
    assert.throws(()=>sourceRecordFromRaw({synthetic:true},{...receipt(null),...change}));
  }
});
