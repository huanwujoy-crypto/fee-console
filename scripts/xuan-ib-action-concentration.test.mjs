// Synthetic values only; public registry identifiers identify the fixed contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fingerprint} from './xuan-ib-run-manifest.mjs';
import {normalizeSharesightReport,PERFORMANCE_MEMBERSHIP_SOURCE,aggregateFourBucket,loadTrustedInputs} from './xuan-ib-four-bucket.mjs';
import {readAiRiskAccounts} from './xuan-ib-ai-coefficient-resolver.mjs';
import {buildAiRiskInput} from './xuan-ib-ai-risk-input.mjs';
import {buildWeeklyConcentration,renderWeeklyConcentration,DEFAULT_TOP10_POLICY} from './xuan-weekly-concentration.mjs';
import {normalizeActionConcentrationSource,buildActionConcentrationCandidate,renderPendingActionConcentration,renderActionConcentration,validateActionConcentration,actionConcentrationResult} from './xuan-ib-action-concentration.mjs';
const cutoff='2026-10-16',captureStartedAt='2026-10-17T05:00:00.000Z',captureCompletedAt='2026-10-17T05:01:00.000Z';
const window={cutoff,captureStartedAt,captureCompletedAt};
globalThis.fetch=()=>assert.fail('Offline only');
const keys=['sharesight.ibGroupedPerformance','sharesight.schwabPerformance','sharesight.webullPerformance'];
function source(index,rows=[]){
  const account=readAiRiskAccounts()[index],id=Number(account.portfolioId);
  const holdings=rows.map(([symbol,value,instrumentId=9000001,type='ordinary_shares'],i)=>({id:9900001+i,portfolio:{id},
    instrument:{id:instrumentId,code:symbol,market_code:'TEST',name:'Synthetic instrument',currency_code:'USD',friendly_instrument_description_code:type},
    instrument_currency:{code:'USD'},valid_position:true,quantity:1,instrument_price:value,value,labels:[],number_of_unconfirmed_transactions:0}));
  const raw={mode:'read_only',portfolio:{id,name:account.custodian,currency_code:'USD'},data:{report:{portfolio_id:id,
    value:1000,start_date:cutoff,end_date:cutoff,percentages_annualised:false,include_sales:false,currency:{code:'USD'},holdings,
    cash_accounts:[{id:8800000+index,portfolio:{id},name:'Synthetic cash',value:Math.round((1000-rows.reduce((s,r)=>s+r[1],0))*100)/100,currency:{code:'USD'}}]},
    links:{self:'https://example.invalid/performance?consolidated=false&include_sales=false&report_combined=false'}}};
  if(index===1)Object.assign(raw,{ok:true,route:'direct'});else raw.source='Sharesight User API';
  return pin(raw,index);
}
function pin(raw,index){const bytes=JSON.stringify(raw);return {bytes,receipt:{sourceKey:keys[index],sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes),
  sourceDate:cutoff,status:'date-verified',route:index===1?'direct':'gateway',startedAt:captureStartedAt,completedAt:'2026-10-17T05:00:01.000Z',syncCompletion:'not-provided'}};}
function fixture(){return [source(0,[['GOOG',15],['BRK.B',12,9000002],['CSPX',100,1310832,'etf']]),source(1,[['GOOGL',14.99],['BRK/B',18,9000002]]),source(2)];}
test('migration reuses exact original issuer calculation and renderer with full cash-inclusive accounts',()=>{
  const sources=fixture(),before=JSON.stringify(sources),candidate=buildActionConcentrationCandidate({sources,...window});
  const reports=sources.map((s,i)=>normalizeActionConcentrationSource(s,{...window,accountKey:readAiRiskAccounts()[i].key}).report);
  const expected=buildWeeklyConcentration(buildAiRiskInput({reports}),{cutoff});
  assert.deepEqual(actionConcentrationResult(candidate),expected);
  const html=renderActionConcentration(candidate),qualifier=html.match(/<p class="muted concentration-basis">[^<]+<\/p>/)?.[0];
  assert.ok(qualifier);assert.ok(html.indexOf(qualifier)<html.indexOf('<details>'));
  assert.ok(html.startsWith('<section class="card concentration"><h2>单票集中度</h2>'));
  assert.match(html,/class="concentration-source-label">发行方前十/);
  assert.doesNotMatch(html,/<a\b|(?:href|src)\s*=|portfolioId=/i);
  assert.match(renderWeeklyConcentration(expected),/<a href=/);
  assert.match(qualifier,/同日账面值 · 来源独立读取 · 已核实下限/);
  assert.equal(actionConcentrationResult(candidate).denominatorCents,'300000');assert(actionConcentrationResult(candidate).rows.some(r=>r.issuer==='ALPHABET'));assert(actionConcentrationResult(candidate).rows.some(r=>r.label==='BRK.B'));
  assert.equal(JSON.stringify(sources),before);assert(candidate.bindings.every(b=>b.sourceStatus==='date-verified'&&b.syncCompletion==='not-attested'));
  assert.equal(candidate.status,'recorded');assert.doesNotMatch(renderActionConcentration(candidate),/Sharesight 记录持仓|股票市值分母/);
});
test('unrounded issuer union is screened at 1%; equal displayed rounded percentages do not change threshold',()=>{
  const below=buildActionConcentrationCandidate({sources:[source(0,[['GOOG',15]]),source(1,[['GOOGL',14.99]]),source(2)],...window});
  assert.equal(actionConcentrationResult(below).identifiedTopFive[0].percent,1);assert.equal(actionConcentrationResult(below).rows.length,0);
  const equal=buildActionConcentrationCandidate({sources:[source(0,[['GOOG',15]]),source(1,[['GOOGL',15]]),source(2)],...window});
  assert.equal(actionConcentrationResult(equal).rows[0].percent,1);assert.equal(actionConcentrationResult(equal).rows[0].equivalentExposureCents,'3000');
});
test('Sep30 refresh restores five-fund coverage while expired historical policy stays unknown without ETF double counting',()=>{
  const old=DEFAULT_TOP10_POLICY.funds.filter(f=>['MXUS','EQAC','IVAI','EXUS','VCN'].includes(f.symbol));
  const sources=[source(0,old.map(f=>[f.symbol,10,Number(f.instrumentId),'etf'])),source(1),source(2)];
  const c=buildActionConcentrationCandidate({sources,...window});assert.equal(actionConcentrationResult(c).missingFunds.length,0);assert.equal(actionConcentrationResult(c).matchedFunds.length,5);
  const historical=structuredClone(DEFAULT_TOP10_POLICY);for(const f of historical.funds)if(old.some(x=>x.symbol===f.symbol))f.asOf='2026-08-31';
  const expired=buildWeeklyConcentration(c.envelope,{cutoff,policy:historical});assert.equal(expired.missingFunds.length,5);assert.match(renderWeeklyConcentration(expired),/这些敞口不能视为零/);
  const priorCutoff='2026-09-29',priorEnvelope={...c.envelope,riskConstituents:c.envelope.riskConstituents.map(r=>({...r,valueDate:priorCutoff}))};
  assert.equal(buildWeeklyConcentration(priorEnvelope,{cutoff:priorCutoff}).missingFunds.length,5);
  assert.match(renderActionConcentration(c),/可见下限/);assert.equal(actionConcentrationResult(c).denominatorCents,'300000');
});
test('wrong bytes, account identity, route, cutoff, pagination and reconciliation cannot self-certify complete',()=>{
  for(const edit of [s=>s.bytes+=' ',s=>s.receipt.sha256='0'.repeat(64),s=>s.receipt.status='ok',s=>s.receipt.route='direct',
    s=>s.receipt.sourceDate='2026-10-15',s=>s.receipt.startedAt='2026-10-16T05:00:00.000Z']){
    const s=fixture()[0];edit(s);s.complete=true;s.syncCompleted=true;assert.throws(()=>normalizeActionConcentrationSource(s,{...window,accountKey:'ib-hk'}));
  }
  for(const edit of [r=>r.portfolio.name='SYNTHETIC_WRONG_ACCOUNT',r=>r.portfolio.id=99999999,r=>r.data.report.end_date='2026-10-15',
    r=>r.data.report.value++,r=>r.next_cursor='next',r=>r.data.report.holdings[0].instrument.currency_code='CAD']){
    const raw=JSON.parse(fixture()[0].bytes);edit(raw);assert.throws(()=>normalizeActionConcentrationSource(pin(raw,0),{...window,accountKey:'ib-hk'}));
  }
  assert.throws(()=>buildActionConcentrationCandidate({sources:fixture().slice(0,2),...window}),/THREE_ACCOUNT_SOURCES_REQUIRED/);
  assert.throws(()=>buildActionConcentrationCandidate({sources:[fixture()[0],fixture()[0],fixture()[2]],...window}),/MISSING_OR_DUPLICATE/);
});
test('pending action UI names precise missing integration and keeps evidence collapsed',()=>{
  const html=renderPendingActionConcentration();assert.match(html,/未接入 Schwab-HK／Webull 同日来源/);assert.match(html,/<details>/);
  assert.doesNotMatch(html,/approved|批准|范围未确认|Sharesight 记录持仓|<details[^>]*open/);
});
test('native gateway wrapper and independent same-day source windows retain original times without sync claims',()=>{
  const sources=fixture(),raw=JSON.parse(sources[2].bytes);delete raw.source;raw.ok=true;raw.route='gateway';sources[2]=pin(raw,2);
  for(const s of sources.slice(1)){s.receipt.startedAt='2026-10-17T12:30:10.000Z';s.receipt.completedAt='2026-10-17T12:30:20.000Z';}
  const c=buildActionConcentrationCandidate({sources,cutoff});
  assert.equal(c.bindings[0].readCompletedAt,'2026-10-17T05:00:01.000Z');assert.equal(c.bindings[2].readCompletedAt,'2026-10-17T12:30:20.000Z');
  assert.equal(c.readWindow.basis,'independent-same-cutoff');assert.match(renderActionConcentration(c),/非同一次五分钟捕获/);
  for(const edit of [c=>c.resultFingerprint='0'.repeat(64),c=>c.bindings[0].membershipSource='sharesight_get_holdings',c=>c.bindings[0].independentListing='verified',c=>c.bindings[0].readCompletedAt='2026-10-17T05:00:02.000Z']){
    const changed=structuredClone(c);edit(changed);const {bindingFingerprint,...body}=changed;changed.bindingFingerprint=fingerprint(body);assert.throws(()=>validateActionConcentration(changed,cutoff));
  }
});
test('report-derived membership is labelled accurately and stays forbidden for default accounting normalization',()=>{
  const s=fixture()[0],account=readAiRiskAccounts()[0],report=normalizeActionConcentrationSource(s,{...window,accountKey:account.key}).report;
  assert.equal(report.listing.source,PERFORMANCE_MEMBERSHIP_SOURCE);
  assert.throws(()=>aggregateFourBucket({...loadTrustedInputs(),reports:[report]}),/RISK_MEMBERSHIP_ACCOUNTING_FORBIDDEN/);
  const raw=JSON.parse(s.bytes),registry=JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json',import.meta.url)));
  const options={registry,portfolioId:account.portfolioId,readStartedAt:s.receipt.startedAt,readCompletedAt:s.receipt.completedAt,
    listing:{source:PERFORMANCE_MEMBERSHIP_SOURCE,portfolioId:Number(account.portfolioId),readCompletedAt:s.receipt.completedAt,holdingIds:raw.data.report.holdings.map(r=>r.id)}};
  assert.throws(()=>normalizeSharesightReport({...raw,result:raw},options),/LISTING_SOURCE_INVALID/);
  options.unconfirmedTransactionMode='risk-read-only';options.listing.holdingIds.push(123456);assert.throws(()=>normalizeSharesightReport({...raw,result:raw},options),/REPORT_MEMBERSHIP_MISMATCH/);
});
test('verified SU issuer alias merges direct shares with VCN Suncor exposure before the 1% screen',()=>{
  const c=buildActionConcentrationCandidate({sources:[source(0,[['SU',20],['VCN',500,1028072,'etf']]),source(1),source(2)],...window});
  const row=actionConcentrationResult(c).rows.find(r=>r.issuer==='SUNCOR');
  assert.equal(row.directCents,'2000');assert.equal(row.etfCents,'1150');assert.equal(row.equivalentExposureCents,'3150');assert.equal(row.percent,1.05);
  assert.equal(actionConcentrationResult(c).rows.filter(r=>['SU','SUNCOR'].includes(r.issuer)).length,1);
  const withoutAlias=structuredClone(DEFAULT_TOP10_POLICY);delete withoutAlias.directAliases.SU;
  assert.equal(buildWeeklyConcentration(c.envelope,{cutoff,policy:withoutAlias}).rows.filter(r=>['SU','SUNCOR'].includes(r.issuer)).length,0);
});

test('authenticated browser tables reuse the identical three-account weekly arithmetic and current cash denominator',()=>{
  const originals=[source(0,[['GOOG',45],['CSPX',100,1310832,'etf']]),source(1,[['GOOGL',40]]),source(2,[['VSTL',60,9988251,'etf']])];
  const browser=originals.map((s,index)=>{
    const old=JSON.parse(s.bytes),r=old.data.report,a=readAiRiskAccounts()[index];
    if(index===0)Object.assign(r,{grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'}});
    const raw={mode:'read_only',source:'Sharesight authenticated cloud browser visible DOM',observation:{portfolio:a.custodian,portfolioId:Number(a.portfolioId),valuationDate:cutoff,retrievedAt:s.receipt.completedAt,reportingCurrency:'USD',portfolioValue:r.value,
      positions:r.holdings.map(h=>({instrument:h.instrument.code+' | '+h.instrument.market_code,description:h.instrument.name,price:h.instrument_price,priceCurrency:'USD',quantity:h.quantity,marketValueUSD:h.value,sourcePath:'/holdings/'+h.id,priceDate:null})),
      cash:r.cash_accounts.map(c=>({name:c.name,marketValueUSD:c.value,sourcePath:'/cash_accounts/'+c.id,nativeCurrency:'USD',nativeBalance:c.value}))},
      classification:{sourceKey:keys[index],status:'date-verified',raw:old,rawFingerprint:sha(old),provenance:{sourceDate:cutoff,readAt:captureStartedAt}}};
    const bytes=JSON.stringify(raw);return {bytes,receipt:{...s.receipt,route:'authenticated-browser',bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}};
  });
  const result=buildActionConcentrationCandidate({sources:browser,...window});
  assert.deepEqual(actionConcentrationResult(result),actionConcentrationResult(buildActionConcentrationCandidate({sources:originals,...window})));
  assert.equal(result.envelope.riskDenominator.components.length,3);
  assert(result.bindings.every(b=>b.route==='authenticated-browser'));
  const withClosed=structuredClone(browser),closedRaw=JSON.parse(withClosed[2].bytes);
  closedRaw.observation.positions.push({instrument:'CLOSED | TEST',description:'Closed historical row',price:1,priceCurrency:'USD',quantity:0,marketValueUSD:0,sourcePath:'/holdings/123',priceDate:null});
  const bindClosed=()=>{withClosed[2].bytes=JSON.stringify(closedRaw);Object.assign(withClosed[2].receipt,{bytes:Buffer.byteLength(withClosed[2].bytes),sha256:sha(withClosed[2].bytes)});};
  bindClosed();
  const closedResult=buildActionConcentrationCandidate({sources:withClosed,...window});
  assert.deepEqual(actionConcentrationResult(closedResult),actionConcentrationResult(result));
  assert.equal(JSON.parse(withClosed[2].bytes).observation.positions.length,2);
  assert.equal(closedResult.envelope.provenance[2].holdingRows,1);
  for(const field of ['quantity','marketValueUSD']){
    closedRaw.observation.positions.at(-1)[field]=1;
    if(field==='marketValueUSD')closedRaw.observation.portfolioValue+=1;
    bindClosed();assert.throws(()=>buildActionConcentrationCandidate({sources:withClosed,...window}));
    closedRaw.observation.positions.at(-1)[field]=0;
  }
  for(const edit of [r=>r.observation.portfolioId=936246,r=>r.observation.portfolio='HSBC-HK & Webull',r=>r.observation.positions[0].sourcePath='/holdings/123']){
    const bad=structuredClone(browser),raw=JSON.parse(bad[2].bytes);edit(raw);bad[2].bytes=JSON.stringify(raw);Object.assign(bad[2].receipt,{bytes:Buffer.byteLength(bad[2].bytes),sha256:sha(bad[2].bytes)});
    assert.throws(()=>buildActionConcentrationCandidate({sources:bad,...window}));
  }
});
function sha(v){return crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');}


test('TQQQ proxy survives the real action source normalizer and private link-free renderer without changing three-account assets',()=>{
  const sources=[source(0,[['NVDA',100,9000001]]),source(1,[['TQQQ',100,9000002,'etf']]),source(2,[['EQAC',100,1983054,'etf']])];
  const before=JSON.stringify(sources),candidate=buildActionConcentrationCandidate({sources,...window});
  const result=actionConcentrationResult(candidate),nvda=result.rows.find(r=>r.issuer==='NVDA');
  assert.equal(nvda.equivalentExposureCents,'13340');assert.equal(nvda.percent,4.45);
  assert.equal(result.denominatorCents,'300000');assert.equal(result.rows.some(r=>['TQQQ','EQAC'].includes(r.issuer)),false);
  assert.equal(JSON.stringify(sources),before);assert.equal(candidate.envelope.riskConstituents.find(r=>r.symbol==='TQQQ').marketValueMicro,'100000000');
  const html=renderActionConcentration(candidate);assert.match(html,/TQQQ.*EQAC.*前十/);assert.match(html,/2026-09-30/);
  assert.doesNotMatch(html,/<a\b|(?:href|src)\s*=/i);
});
