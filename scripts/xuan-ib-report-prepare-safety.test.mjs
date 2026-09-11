import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareReport,runPrepareCli} from './xuan-ib-report-prepare.mjs';
import {parseDecisionJson} from './xuan-ib-decision-menu.mjs';
import {fingerprint,APPROVED_IB_ACCOUNT_ID} from './xuan-ib-run-manifest.mjs';
import {initRunJournal,startJournalStage,finishJournalStage} from './xuan-ib-run-clock.mjs';
import {inactiveAssociationSnapshot} from './xuan-ib-association-test-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const previousHtml=fs.readFileSync(path.join(root,'xuan-ib/latest.html'),'utf8');
const previousMeta=JSON.parse(fs.readFileSync(path.join(root,'xuan-ib/latest.meta.json'),'utf8'));
const policy=JSON.parse(fs.readFileSync(path.join(root,'claude/xuan-ib-policy-v2.json'),'utf8'));
const registry=JSON.parse(fs.readFileSync(path.join(root,'claude/xuan-ib-portfolio-registry.json'),'utf8'));
const decisionJson=previousHtml.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)?.[1];
const decisionState=parseDecisionJson(decisionJson,2_000_000);
const dataDate=previousMeta.dataDate;
const hktStamp=`${dataDate} 21:36–21:39 HKT`;
const instant=`${dataDate}T21:38:00+08:00`;
const context={previousHtml,previousMeta,policy,registry,get associationSnapshot(){return inactiveAssociationSnapshot();}};
const card=title=>({title,asOfHkt:hktStamp,lines:['合成安全测试；不是金融数据。'],columns:['项目','状态'],rows:[['合成项','仅测试']]});

const view=()=>({schemaVersion:1,edition:'adhoc',dataDate,asOfHkt:hktStamp,
  marketContext:'合成安全测试',alerts:[{level:'warning',text:'合成测试，不得发布。'}],
  summary:['合成摘要一。','合成摘要二。','合成摘要三。'],
  kpis:[{label:'合成 NAV',value:100,format:'usd',asOfHkt:hktStamp,note:'合成数值'},
    {label:'合成现金',value:null,format:'usd',asOfHkt:hktStamp,note:'缺失不填零'},
    {label:'合成比例',value:1,format:'percent',asOfHkt:hktStamp,note:'仅测试'}],
  holdings:{status:'ok',asOfHkt:hktStamp,authoritativeValueUsd:100,note:'合成持仓。',rows:[
    {symbol:'SYNTH',market:'TEST',quantity:1,price:100,priceCurrency:'USD',marketValueUsd:100,changePct:null,changeAsOfHkt:null,quoteStatus:'unavailable'}]},
  risk:[card('② 风险')],allocation:[card('④ 配置')],rotation:card('换仓'),events:card('日历未查询'),
  decisions:decisionState.decisions.map(item=>({decisionId:item.decisionId,asOfHkt:hktStamp,fact:'合成事实；不改历史意见。',isNew:false})),
  observations:['合成观察'],notes:['版次与时点：合成。','数据与口径：合成。','只读验证，不执行交易。'],
  cashPlan:{schemaVersion:2,status:'unavailable'}});

const evidence=()=>{
  const source=label=>({status:'ok',asOf:instant,retries:0,fingerprint:fingerprint({synthetic:label})});
  return {schemaVersion:1,edition:'adhoc',dataDate,previousSourceSha:previousMeta.sourceSha,sources:{
    ib:{accountId:APPROVED_IB_ACCOUNT_ID,accountScopeConfirmed:true,...Object.fromEntries(['accountSummary','balances','positions','orders','trades'].map(name=>[name,source(name)]))},
    sharesight:registry.portfolios.filter(item=>item.requiredEachReport).map(item=>({portfolioId:item.portfolioId,role:item.role,...source(item.portfolioId),...(item.portfolioId===936247?{completedUsTradingDayLag:0}:{})}))}};
};
const unusable=(source,status='failed')=>Object.assign(source,{status,asOf:null,fingerprint:null,errorCode:'SYNTHETIC_FAILURE'});

test('operational CLI requires a real journal, with no silent untimed mode',()=>{
  assert.throws(()=>runPrepareCli(['view.json','sources.json','candidate.html']),/journal.*required/);
  assert.throws(()=>runPrepareCli(['view.json','sources.json','candidate.html','--journal','']),/journal is required/);
});

test('compact pilot rejects any non-position critical IB degradation',()=>{
  for(const endpoint of ['accountSummary','balances','orders','trades']){
    for(const status of ['failed','unavailable','fallback']){
      const input=evidence();
      if(status==='fallback')input.sources.ib[endpoint].status=status;
      else unusable(input.sources.ib[endpoint],status);
      assert.throws(()=>prepareReport(view(),input,context),new RegExp(`direct IB ${endpoint}`));
    }
  }
});

test('positions accept only a fresh approved IB-HK fallback and never unavailable',()=>{
  const valid=evidence();unusable(valid.sources.ib.positions);
  const fallbackView=view();fallbackView.holdings.status='fallback';
  assert.equal(prepareReport(fallbackView,valid,context).result.degraded,true);

  const stale=evidence();unusable(stale.sources.ib.positions);
  stale.sources.sharesight.find(item=>item.portfolioId===936247).completedUsTradingDayLag=2;
  assert.throws(()=>prepareReport(fallbackView,stale,context),/requires direct positions or the approved IB-HK fallback|freshness limit/);

  const noLag=evidence();unusable(noLag.sources.ib.positions);
  delete noLag.sources.sharesight.find(item=>item.portfolioId===936247).completedUsTradingDayLag;
  assert.throws(()=>prepareReport(fallbackView,noLag,context),/requires direct positions or the approved IB-HK fallback/);

  const staleRead=evidence();unusable(staleRead.sources.ib.positions);
  staleRead.sources.sharesight.find(item=>item.portfolioId===936247).asOf='2026-08-24';
  assert.throws(()=>prepareReport(fallbackView,staleRead,context),/required Sharesight portfolio .* is not fresh/);

  const missing=evidence();unusable(missing.sources.ib.positions);
  const ibHk=missing.sources.sharesight.find(item=>item.portfolioId===936247);
  unusable(ibHk);delete ibHk.completedUsTradingDayLag;
  assert.throws(()=>prepareReport(fallbackView,missing,context),/requires direct positions or the approved IB-HK fallback|publication blocked/);

  const selfClaimed=evidence();selfClaimed.sources.ib.positions.status='fallback';
  assert.throws(()=>prepareReport(fallbackView,selfClaimed,context),/must be derived from an unavailable direct endpoint/);

  const secondFailure=evidence();unusable(secondFailure.sources.ib.positions);unusable(secondFailure.sources.ib.orders);
  assert.throws(()=>prepareReport(fallbackView,secondFailure,context),/direct IB orders|publication blocked/);
});

test('all direct IB and required Sharesight read times must be on the report HKT date',()=>{
  const oldIb=evidence();oldIb.sources.ib.orders.asOf='2026-08-24T23:59:00+08:00';
  assert.throws(()=>prepareReport(view(),oldIb,context),/direct IB orders is not fresh/);

  for(let index=0;index<evidence().sources.sharesight.length;index+=1){
    const oldSharesight=evidence();oldSharesight.sources.sharesight[index].asOf='2026-08-24';
    assert.throws(()=>prepareReport(view(),oldSharesight,context),/required Sharesight portfolio .* is not fresh/);
    for(const status of ['failed','unavailable','fallback']){
      const unavailableSharesight=evidence(),source=unavailableSharesight.sources.sharesight[index];
      if(status==='fallback')source.status=status;else unusable(source,status);
      assert.throws(()=>prepareReport(view(),unavailableSharesight,context),/required Sharesight portfolio .* is not fresh and direct/);
    }
  }
});

test('direct IB freshness converts explicit offsets at the HKT day boundary',()=>{
  const hktStart=Date.parse(`${dataDate}T00:00:00Z`)-8*60*60_000;
  for(const value of [new Date(hktStart).toISOString(),new Date(hktStart+24*60*60_000-1).toISOString()]){
    const input=evidence();input.sources.ib.orders.asOf=value;
    assert.equal(prepareReport(view(),input,context).result.status,'prepared-not-published');
  }
  for(const value of [new Date(hktStart-1).toISOString(),new Date(hktStart+24*60*60_000).toISOString(),`${dataDate}T23:59:00-08:00`]){
    const input=evidence();input.sources.ib.orders.asOf=value;
    assert.throws(()=>prepareReport(view(),input,context),/direct IB orders is not fresh/);
  }
  const dateOnly=evidence();dateOnly.sources.ib.orders.asOf=dataDate;
  assert.throws(()=>prepareReport(view(),dateOnly,context),/RFC 3339 read instant/);
});

test('positive direct authoritative value cannot be paired with an empty holding list',()=>{
  for(const value of [100,0.01]){
    const empty=view();empty.holdings.rows=[];empty.holdings.authoritativeValueUsd=value;
    assert.throws(()=>prepareReport(empty,evidence(),context),/positive direct authoritative holdings/);
  }
  const zero=view();zero.holdings.rows=[];zero.holdings.authoritativeValueUsd=0;
  assert.equal(prepareReport(zero,evidence(),context).result.status,'prepared-not-published');
});

// The measured daily-change column is edition-bound: AM publishes the completed
// session before its Hong Kong date from the window source, PM publishes the
// session running on that date from the same positions payload, and the retired
// ad-hoc edition publishes no measured column at all.
const priorSession=new Date(Date.parse(`${dataDate}T00:00:00Z`)-86_400_000).toISOString().slice(0,10);
const measuredView=(edition,over={})=>{
  const base=edition==='am'
    ?{changePct:1.25,changeAsOfHkt:priorSession,changeMethod:'window-v1',changeSessionDate:priorSession}
    :{changePct:1.25,changeAsOfHkt:`${dataDate} 21:38 HKT`,changeMethod:'session-pnl-v1',changeSessionDate:dataDate};
  const input=view();input.edition=edition;
  input.holdings.rows=[{symbol:'SYNTH',market:'TEST',quantity:1,price:100,priceCurrency:'USD',
    marketValueUsd:100,quoteStatus:'ok',...base,...over}];
  return input;
};
const measuredEvidence=edition=>Object.assign(evidence(),{edition});
// The same single constituent the measured view holds, resolved through the
// real classification path. SYNTH reaches no WU or DELEG rule, so an ordinary
// scheduled edition must classify it automatically rather than let it fall out
// of the AI-pressure numerator while staying in the denominator.
const measuredConstituents=[{symbol:'SYNTH',custodian:'Webull',venue:'TEST',portfolioId:'1350094',
  holdingId:'99000001',instrumentId:'99000001',currency:'USD',assetType:'STK',marketValueUsd:100,
  valueDate:dataDate,identityVerified:true,firstSeen:true}];
// Source-bound account totals, supplied by the caller; never fetched here.
const measuredDenominator={components:[{label:'合成账户',valueUsd:1000}]};
const measuredContext={...context,riskConstituents:measuredConstituents,
  riskDenominator:measuredDenominator};

test('a measured daily change may name only its own edition method, session and label',()=>{
  for(const edition of ['am','pm']){
    assert.equal(prepareReport(measuredView(edition),measuredEvidence(edition),measuredContext).result.status,'prepared-not-published');
  }
  // Neither edition may borrow the other's method, whose behaviour in the other
  // edition's session has not been measured.
  assert.throws(()=>prepareReport(measuredView('am',{changeMethod:'session-pnl-v1'}),measuredEvidence('am'),measuredContext),
    /method this edition may not publish/);
  assert.throws(()=>prepareReport(measuredView('pm',{changeMethod:'window-v1'}),measuredEvidence('pm'),measuredContext),
    /method this edition may not publish/);
  // The retired ad-hoc edition has no measured column.
  assert.throws(()=>prepareReport(measuredView('adhoc'),evidence(),context),
    /edition may not publish a measured daily change/);
  // AM may not relabel the running session, and PM may not relabel yesterday's.
  assert.throws(()=>prepareReport(measuredView('am',{changeAsOfHkt:dataDate,changeSessionDate:dataDate}),measuredEvidence('am'),measuredContext),
    /outside the report window/);
  assert.throws(()=>prepareReport(measuredView('pm',{changeAsOfHkt:`${priorSession} 21:38 HKT`,changeSessionDate:priorSession}),measuredEvidence('pm'),measuredContext),
    /outside the report window/);
  // An intraday reading must name the minute it was taken; a completed session
  // must not be dressed up as one.
  assert.throws(()=>prepareReport(measuredView('pm',{changeAsOfHkt:dataDate}),measuredEvidence('pm'),measuredContext),
    /label does not match its measurement method/);
  assert.throws(()=>prepareReport(measuredView('am',{changeAsOfHkt:`${priorSession} 21:38 HKT`}),measuredEvidence('am'),measuredContext),
    /label does not match its measurement method/);
  assert.throws(()=>prepareReport(measuredView('am',{changeMethod:'invented'}),measuredEvidence('am'),measuredContext),
    /known measurement method/);
});

function withJournal(statuses,run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-prepare-safety-')),journal=path.join(dir,'clock.jsonl');
  try{
    initRunJournal(journal);
    for(const name of ['bootstrap','ib-read','sharesight-read','validate','derive','narrative']){
      startJournalStage(journal,name);
      const choice=statuses[name]||{status:'ok'},status=choice.status||choice;
      finishJournalStage(journal,name,status==='ok'?{}:{status,errorCode:choice.errorCode||'SYNTHETIC_STAGE'});
    }
    return run(journal);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('journal rejects failed upstream and degraded bootstrap, validate or derive',()=>{
  for(const [stage,status] of [
    ['bootstrap','degraded'],['bootstrap','failed'],['sharesight-read','degraded'],['sharesight-read','failed'],
    ['validate','degraded'],['validate','failed'],['derive','degraded'],['derive','failed'],
    ['ib-read','failed'],['narrative','failed']]){
    withJournal({[stage]:status},journal=>assert.throws(()=>prepareReport(view(),evidence(),{...context,journalPath:journal}),new RegExp(`stage ${stage}`)));
  }
});

test('journal permits only source-bound IB fallback and the named reduced narrative mode',()=>{
  withJournal({narrative:{status:'degraded',errorCode:'NARRATIVE_REDUCED'}},journal=>{
    const prepared=prepareReport(view(),evidence(),{...context,journalPath:journal});
    assert.equal(prepared.result.status,'prepared-not-published');
  });

  const fallback=evidence();unusable(fallback.sources.ib.positions);
  const fallbackView=view();fallbackView.holdings.status='fallback';
  withJournal({'ib-read':{status:'degraded',errorCode:'IB_POSITIONS_FALLBACK'}},journal=>{
    assert.equal(prepareReport(fallbackView,fallback,{...context,journalPath:journal}).result.degraded,true);
  });

  for(const statuses of [
    {'ib-read':{status:'degraded',errorCode:'IB_POSITIONS_FALLBACK'}},
    {'sharesight-read':{status:'degraded',errorCode:'SYNTHETIC_STAGE'}},
    {narrative:{status:'degraded',errorCode:'SYNTHETIC_STAGE'}}]){
    withJournal(statuses,journal=>assert.throws(()=>prepareReport(view(),evidence(),{...context,journalPath:journal}),/upstream journal stage/));
  }
});
