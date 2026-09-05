import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { renderReport, validateReportView, reportHtmlBlob } from './xuan-ib-report-view.mjs';
import { buildDecisionMenu } from './xuan-ib-decision-menu.mjs';
import { prepareReport, runPrepareCli } from './xuan-ib-report-prepare.mjs';
import { APPROVED_IB_ACCOUNT_ID, fingerprint } from './xuan-ib-run-manifest.mjs';
import { initRunJournal, startJournalStage, finishJournalStage, showRunJournal } from './xuan-ib-run-clock.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Existing public history is read, never rewritten or copied into a new fixture.
const previousHtml=fs.readFileSync(path.join(root,'xuan-ib/latest.html'),'utf8');
const previousMeta=JSON.parse(fs.readFileSync(path.join(root,'xuan-ib/latest.meta.json'),'utf8'));
const policy=JSON.parse(fs.readFileSync(path.join(root,'claude/xuan-ib-policy-v2.json'),'utf8'));
const priorTemplate=previousHtml.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)[0];
const priorState=JSON.parse(priorTemplate.replace(/^[^>]*>/,'').replace(/<\/template>$/,''));
const context={previousHtml,previousMeta,policy};
const registry=JSON.parse(fs.readFileSync(path.join(root,'claude/xuan-ib-portfolio-registry.json'),'utf8'));
const fixtureDate=previousMeta.dataDate;
const stamp=`${fixtureDate} 21:36–21:39 HKT`;
const card=title=>({title,asOfHkt:stamp,lines:['合成测试；不是实际报告或投资建议。'],columns:['项目','读数'],rows:[['合成项','仅测试'] ]});
const fixture=()=>({schemaVersion:1,edition:'adhoc',dataDate:fixtureDate,asOfHkt:stamp,
  marketContext:'合成测试 · 非真实运行',alerts:[{level:'warning',text:'合成测试数据；不得发布。'}],
  summary:['合成测试摘要一。','合成测试摘要二。','合成测试摘要三。'],
  kpis:[{label:'测试 NAV',value:100,format:'usd',asOfHkt:stamp,note:'合成数值'},
    {label:'测试现金',value:null,format:'usd',asOfHkt:stamp,note:'缺失不填零'},
    {label:'历史快照',value:10,format:'percent',asOfHkt:'2026-08-24',note:'仅合成测试'}],
  holdings:{status:'ok',asOfHkt:stamp,authoritativeValueUsd:100,note:'估值价与日涨跌来源分开。合成测试。',rows:[
    {symbol:'TESTA',market:'TEST',quantity:1,price:10,priceCurrency:'USD',marketValueUsd:10,changePct:1,changeAsOfHkt:stamp,quoteStatus:'ok'},
    {symbol:'TESTB',market:'TEST',quantity:1,price:10,priceCurrency:'USD',marketValueUsd:10,changePct:-0.5,changeAsOfHkt:stamp,quoteStatus:'delayed'},
    {symbol:'TESTC',market:'TEST',quantity:1,price:null,priceCurrency:'USD',marketValueUsd:null,changePct:null,changeAsOfHkt:null,quoteStatus:'unavailable'}]},
  risk:[card('② 风险')],allocation:[card('④ 配置')],rotation:card('换仓'),events:card('日历未查询'),
  decisions:priorState.decisions.map(item=>({decisionId:item.decisionId,
    asOfHkt:stamp,fact:'只验证当前事实显示，不改变历史意见。',isNew:false})),
  observations:['合成测试观察'],notes:['版次与时点：合成测试。','数据与口径：不得当作金融数据。','只读验证，不执行交易。'],
  cashPlan:{schemaVersion:2,status:'unavailable'}});
function runGuard(html,reportDate=fixtureDate){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-compact-test-'));
  try{
    const candidate=path.join(dir,'candidate.html');fs.writeFileSync(candidate,html);
    return spawnSync(process.execPath,[path.join(root,'scripts/handover-guard.mjs'),candidate,reportDate,path.join(root,'xuan-ib/latest.html')],{
      env:{...process.env,XUAN_IB_PREVIOUS_SOURCE_SHA:previousMeta.sourceSha,XUAN_IB_PREVIOUS_HTML_BLOB:previousMeta.htmlBlob,XUAN_IB_POLICY_V2_JSON:path.join(root,'claude/xuan-ib-policy-v2.json')},encoding:'utf8'});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('synthetic compact report passes unchanged trusted guard and native menu',()=>{
  const html=renderReport(fixture(),context);const result=runGuard(html);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(buildDecisionMenu({html,meta:{...previousMeta,htmlBlob:reportHtmlBlob(html)}}).pending.length,priorState.decisions.filter(item=>item.status==='awaiting_user').length);
  assert.ok(html.includes(priorTemplate),'unchanged entire decision template bytes');
  assert.ok(!/<script\b|<form\b|<button\b/i.test(html));
  assert.ok(html.includes('<details open><summary>⑥ 换仓触发检查'));
  assert.ok(html.includes('<details><summary>三行摘要'));
});
test('known >=1%, small changes and missing quotes are disjoint and counted',()=>{
  const html=renderReport(fixture(),context);
  for(const title of ['价格变化 ≥1%（1）','其它持仓（1）','涨跌数据待核验（1）'])assert.ok(html.includes(title));
  assert.ok(html.includes('未取得'));assert.ok(!html.includes('TESTC</span><span class="sub">TEST · 1</span></td><td>USD 0'));
});
test('outdated daily change does not masquerade as a current large move',()=>{
  const view=fixture();view.holdings.rows[0].changeAsOfHkt='2026-08-24';
  const html=renderReport(view,context);assert.ok(html.includes('价格变化 ≥1%（0）'));assert.ok(html.includes('涨跌数据待核验（2）'));assert.ok(html.includes('1%（旧值）'));
});
test('missing and zero remain different; source timestamps are mandatory',()=>{
  const view=fixture();view.kpis[0].value=0;
  const html=renderReport(view,context);assert.ok(html.includes('$0'));assert.ok(html.includes('待核实'));
  delete view.kpis[0].asOfHkt;assert.throws(()=>renderReport(view,context),/fields/);
});
test('unavailable quote is null and cannot be smuggled into known group',()=>{
  const view=fixture();view.holdings.rows[2].changePct=0;assert.throws(()=>validateReportView(view),/unavailable quote/);
  const other=fixture();other.holdings.rows[0].changeAsOfHkt=null;assert.throws(()=>validateReportView(other),/source time/);
});
test('escapes injection in every free text field, never interprets HTML',()=>{
  const view=fixture();view.summary[0]='<script>alert("x")</script>';view.risk[0].rows[0][1]='<img onerror="bad()">';
  const html=renderReport(view,context);assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img onerror=&quot;bad()&quot;&gt;'));assert.ok(!html.includes('<script>'));
});
test('rejects unsupported schemas, raw credentials, oversized narrative, NaN and duplicate holdings',()=>{
  for(const edit of [v=>{v.token='secret';},v=>{v.summary[0]='Bearer secret';},v=>{v.summary[0]='a'.repeat(151);},v=>{v.kpis[0].value=NaN;},v=>{v.holdings.rows.push({...v.holdings.rows[0]});},v=>{v.edition='am';}]){
    const view=fixture();edit(view);assert.throws(()=>validateReportView(view));
  }
});
test('rejects missing history, mismatch and dropped/recreated prior decisions',()=>{
  assert.throws(()=>renderReport(fixture(),{...context,previousMeta:{...previousMeta,htmlBlob:'0'.repeat(40)}}));
  const view=fixture();view.decisions.pop();assert.throws(()=>renderReport(view,context),/every old decision/);
  const recreated=fixture();Object.assign(recreated.decisions[0],{isNew:true,title:'测试',recommendation:'测试',options:['测试甲','测试乙']});assert.throws(()=>renderReport(recreated,context),/recreated|report date/);
});
test('new issue is awaiting_user only; old receipts and statuses remain exact',()=>{
  const view=fixture();view.decisions.push({decisionId:`D-${fixtureDate.replaceAll('-','')}-SYNTHETIC`,title:'测试新问题',asOfHkt:stamp,fact:'合成事实',options:['仅观察','待复核'],recommendation:'仅测试',isNew:true});
  const html=renderReport(view,context);const next=JSON.parse(html.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)[1]);
  assert.deepEqual(next.receipts,priorState.receipts);assert.deepEqual(next.decisions.slice(0,-1),priorState.decisions);assert.equal(next.decisions.at(-1).status,'awaiting_user');
  const receiptBytes=priorTemplate.slice(priorTemplate.indexOf('"receipts"'));
  assert.ok(html.includes(receiptBytes));
  const result=runGuard(html);assert.equal(result.status,0,result.stderr+result.stdout);
});
test('deterministic render is lightweight and is NOT an end-to-end timing claim',()=>{
  const view=fixture();const start=performance.now();const a=renderReport(view,context),b=renderReport(view,context);
  assert.equal(a,b);assert.ok(performance.now()-start<5000);assert.ok(Buffer.byteLength(a)<100000);
});

test('next-day and weekend report preserves pending ABC semantics and passes guard',()=>{
  const view=fixture();const next=new Date(`${fixtureDate}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);
  view.dataDate=next.toISOString().slice(0,10);view.asOfHkt=`${view.dataDate} 08:01–08:04 HKT`;
  const html=renderReport(view,context);const result=runGuard(html,view.dataDate);assert.equal(result.status,0,result.stderr+result.stdout);
  const summary=previousHtml.match(/<template id="xuan-etf-open-summary-v3" type="application\/json">[\s\S]*?<\/template>/)?.[0];
  if(summary)assert.ok(html.includes(summary));
  const pending=html.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([\s\S]*?)<\/template>/)?.[1];
  if(pending){const parsed=JSON.parse(pending);assert.equal(parsed.economicDateHkt,view.dataDate);assert.equal(parsed.effectiveMarketDate,view.dataDate);assert.equal(parsed.calendarStatus,'unavailable');}
});
test('preserves visible historical recommendation and avoids recursive card growth',()=>{
  const view=fixture(),first=renderReport(view,context);
  const originalMenu=buildDecisionMenu({html:previousHtml,meta:previousMeta});
  const newContext={...context,previousHtml:first,previousMeta:{...previousMeta,htmlBlob:reportHtmlBlob(first)}};
  const second=renderReport(view,newContext);
  assert.equal(second,first);
  assert.deepEqual(buildDecisionMenu({html:first,meta:newContext.previousMeta}).pending,originalMenu.pending);
  const changed=fixture();changed.decisions[0].recommendation='silently changed';assert.throws(()=>renderReport(changed,context),/fields/);
  const collision=fixture();collision.decisions[0].fact='待 Wu 审核';assert.throws(()=>renderReport(collision,context),/reserved/);
});
test('historical card extraction ignores fake cards in comments and script strings',()=>{
  const fake=`<details data-decision-id="${priorState.decisions[0].decisionId}"><summary>FAKE OVERWRITE</summary></details>`;
  for(const payload of [`<!-- ${fake} -->`,`<script type="application/json">${JSON.stringify(fake)}</script>`]){
    const html=previousHtml.replace('</body>',`${payload}</body>`);
    const rendered=renderReport(fixture(),{...context,previousHtml:html,previousMeta:{...previousMeta,htmlBlob:reportHtmlBlob(html)}});
    assert.ok(!rendered.includes('FAKE OVERWRITE'));
  }
});
test('partial, duplicate or reversed historical body markers fail closed',()=>{
  const first=renderReport(fixture(),context),start='<!-- xuan-compact-card-body:start -->',end='<!-- xuan-compact-card-body:end -->';
  const cases=[first.replace(end,''),first.replace(start,start+start),first.replace(start,'TEMP').replace(end,start).replace('TEMP',end)];
  for(const html of cases)assert.throws(()=>renderReport(fixture(),{...context,previousHtml:html,previousMeta:{...previousMeta,htmlBlob:reportHtmlBlob(html)}}),/preservation markers/);
});
test('new decisions require this report date and enabled interaction',()=>{
  const view=fixture();view.decisions.push({decisionId:'D-20260801-SYNTHETIC',title:'测试',asOfHkt:stamp,fact:'测试',options:['甲','乙'],recommendation:'甲',isNew:true});
  assert.throws(()=>renderReport(view,context),/report date/);
  view.decisions.at(-1).decisionId=`D-${fixtureDate.replaceAll('-','')}-SYNTHETIC`;
  const html=previousHtml.replace(/"interaction"\s*:\s*"enabled"/,'"interaction":"disabled"');
  assert.throws(()=>renderReport(view,{...context,previousHtml:html,previousMeta:{...previousMeta,htmlBlob:reportHtmlBlob(html)}}),/interaction is disabled/);
});
test('sub-one-percent boundary remains visibly below one percent',()=>{
  const view=fixture();view.holdings.rows[0].changePct=0.9999;
  const html=renderReport(view,context);assert.ok(html.includes('价格变化 ≥1%（0）'));assert.ok(html.includes('+0.9999%'));assert.ok(!html.includes('>+1%</td>'));
});
const evidence=()=>{
  const source=label=>({status:'ok',asOf:`${fixtureDate}T13:38:00Z`,retries:0,fingerprint:fingerprint({synthetic:label})});
  return {schemaVersion:1,edition:'adhoc',dataDate:fixtureDate,previousSourceSha:previousMeta.sourceSha,sources:{
    ib:{accountId:APPROVED_IB_ACCOUNT_ID,accountScopeConfirmed:true,
      ...Object.fromEntries(['accountSummary','balances','positions','orders','trades'].map(name=>[name,source(name)]))},
    sharesight:registry.portfolios.filter(p=>p.requiredEachReport).map(p=>({...source(p.portfolioId),portfolioId:p.portfolioId,role:p.role,...(p.portfolioId===936247?{completedUsTradingDayLag:0}:{})}))}};
};
test('prepare checks source scope, guards once, and never claims publication',()=>{
  const result=prepareReport(fixture(),evidence(),{...context,registry});
  assert.equal(result.result.status,'prepared-not-published');assert.equal(result.result.htmlBlob,reportHtmlBlob(result.html));
});
test('unknown scope and multiple critical source failures fail closed',()=>{
  const unknown=evidence();unknown.sources.ib.accountScopeConfirmed=false;assert.throws(()=>prepareReport(fixture(),unknown,{...context,registry}),/ACCOUNT_SCOPE/);
  const failed=evidence();for(const key of ['accountSummary','balances'])Object.assign(failed.sources.ib[key],{status:'failed',errorCode:'TIMEOUT',asOf:null,fingerprint:null});
  assert.throws(()=>prepareReport(fixture(),failed,{...context,registry}),/blocked/);
});
test('single positions fallback remains possible with automatic visible disclosure',()=>{
  const data=evidence();Object.assign(data.sources.ib.positions,{status:'failed',errorCode:'TIMEOUT',asOf:null,fingerprint:null});
  const view=fixture();view.holdings.status='fallback';
  const prepared=prepareReport(view,data,{...context,registry});assert.equal(prepared.result.degraded,true);assert.ok(prepared.html.includes('持仓使用获批替代源'));
});
test('missing auxiliary portfolios, identity mismatch and stale direct holdings cannot pass prepare',()=>{
  const data=evidence();data.sources.sharesight.pop();assert.throws(()=>prepareReport(fixture(),data,{...context,registry}));
  const wrong=evidence();wrong.previousSourceSha='0'.repeat(40);assert.throws(()=>prepareReport(fixture(),wrong,{...context,registry}),/mismatch/);
  const stale=fixture();stale.holdings.asOfHkt='2026-08-24';assert.throws(()=>prepareReport(stale,evidence(),{...context,registry}),/current/);
});
test('prepare appends real render/guard events to a journal begun upstream',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-prepare-clock-')),journalPath=path.join(dir,'clock.jsonl');
  try{initRunJournal(journalPath);for(const name of ['bootstrap','ib-read','sharesight-read','validate','derive','narrative']){startJournalStage(journalPath,name);finishJournalStage(journalPath,name);}
    prepareReport(fixture(),evidence(),{...context,registry,journalPath});
    const observed=showRunJournal(journalPath);assert.ok(observed.timing.completedStages.includes('guard'));assert.equal(observed.manifestStages,null);assert.equal(observed.sourceBinding,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('operational CLI writes guarded candidate once and completes all nine measured stages',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-prepare-cli-'));
  const journalPath=path.join(dir,'clock.jsonl'),viewFile=path.join(dir,'view.json'),sourceFile=path.join(dir,'sources.json'),output=path.join(dir,'candidate.html');
  try{
    fs.writeFileSync(viewFile,JSON.stringify(fixture()),{mode:0o600});
    fs.writeFileSync(sourceFile,JSON.stringify(evidence()),{mode:0o600});
    initRunJournal(journalPath);
    for(const name of ['bootstrap','ib-read','sharesight-read','validate','derive','narrative']){startJournalStage(journalPath,name);finishJournalStage(journalPath,name);}
    const args=[viewFile,sourceFile,output,'--journal',journalPath],result=runPrepareCli(args);
    assert.equal(result.status,'prepared-not-published');
    assert.equal(reportHtmlBlob(fs.readFileSync(output,'utf8')),result.htmlBlob);
    assert.equal(fs.statSync(output).mode&0o777,0o600);
    const observed=showRunJournal(journalPath);
    assert.equal(observed.timing.completedStages.length,9);assert.equal(observed.manifestStages.length,9);assert.equal(observed.sourceBinding,null);
    assert.throws(()=>runPrepareCli(args),/already exists/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('draft preflight is side-effect free and a 203-character correction reuses the same reads',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-draft-check-'));
  const journalPath=path.join(dir,'clock.jsonl'),viewFile=path.join(dir,'view.json'),baseline=path.join(dir,'baseline.json');
  try{
    initRunJournal(journalPath);
    for(const name of ['bootstrap','ib-read','sharesight-read','validate','derive']){startJournalStage(journalPath,name);finishJournalStage(journalPath,name);}
    startJournalStage(journalPath,'narrative');
    const view=fixture();view.observations[0]='长'.repeat(203);
    fs.writeFileSync(viewFile,JSON.stringify(view));
    fs.writeFileSync(baseline,JSON.stringify(view));
    const before=fs.readFileSync(journalPath,'utf8');
    assert.throws(()=>runPrepareCli(['preflight-view',viewFile]),/observations\[0\]/);
    assert.equal(fs.readFileSync(journalPath,'utf8'),before);
    assert.deepEqual(showRunJournal(journalPath).timing.runningStages,['narrative']);
    view.observations[0]='短'.repeat(200);fs.writeFileSync(viewFile,JSON.stringify(view));
    assert.deepEqual(runPrepareCli(['preflight-text-retry',baseline,viewFile]),{status:'valid-text-only-not-prepared',changed:1});
    assert.equal(fs.readFileSync(journalPath,'utf8'),before);
    finishJournalStage(journalPath,'narrative',{status:'degraded',errorCode:'NARRATIVE_REDUCED'});
    const prepared=prepareReport(view,evidence(),{...context,registry,journalPath});
    assert.equal(prepared.result.status,'prepared-not-published');
    const events=fs.readFileSync(journalPath,'utf8').trim().split('\n').map(JSON.parse);
    for(const name of ['ib-read','sharesight-read']){
      assert.equal(events.filter(x=>x.type==='stage-start'&&x.stage===name).length,1);
      assert.equal(events.find(x=>x.type==='stage-finish'&&x.stage===name).cacheHit,false);
    }
    assert.equal(showRunJournal(journalPath).stages.find(x=>x.name==='narrative').errorCode,'NARRATIVE_REDUCED');
    assert.deepEqual(fs.readdirSync(dir).sort(),['baseline.json','clock.jsonl','view.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('draft checks cannot forgive financial/schema/privacy errors or bypass final validation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-draft-fail-')),file=path.join(dir,'view.json');
  try{
    for(const mutate of [v=>{v.holdings.rows[0].quantity=null;},v=>{v.summary.pop();},v=>{v.notes[0]='Bearer secret';}]){
      const view=fixture();mutate(view);fs.writeFileSync(file,JSON.stringify(view));
      assert.throws(()=>runPrepareCli(['preflight-view',file]));
    }
    const view=fixture();fs.writeFileSync(file,JSON.stringify(view));runPrepareCli(['preflight-view',file]);
    view.observations[0]='长'.repeat(203);
    assert.throws(()=>prepareReport(view,evidence(),{...context,registry}),/observations\[0\]/);
    fs.writeFileSync(file,'{"schemaVersion":1,"schemaVersion":1}');
    assert.throws(()=>runPrepareCli(['preflight-view',file]));
    assert.throws(()=>runPrepareCli(['preflight-view',file,'extra']),/Usage/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('local text retry refuses valid-looking changes to financial values or decision facts',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-draft-bound-')),base=path.join(dir,'base.json'),candidate=path.join(dir,'candidate.json');
  try{
    const initial=fixture();initial.observations[0]='长'.repeat(203);fs.writeFileSync(base,JSON.stringify(initial));
    for(const mutate of [v=>{v.kpis[0].value+=1;},v=>{v.decisions[0].fact='changed';},v=>{v.notes.push('extra');}]){
      const next=structuredClone(initial);next.observations[0]='短句';mutate(next);fs.writeFileSync(candidate,JSON.stringify(next));
      assert.throws(()=>runPrepareCli(['preflight-text-retry',base,candidate]),/TEXT_RETRY/);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('compact cards show source-backed status/action, short tables, folded detail and a guide',()=>{
  const view=fixture();view.risk[0].brief={state:'unavailable',takeaway:'数据未取得，不作风险判断。',action:'verify'};
  view.risk[0].lines=['详细依据一','详细依据二'];view.risk[0].rows=Array.from({length:7},(_,i)=>[`合成${i}`,String(i)]);
  const html=renderReport(view,context);
  assert.ok(html.includes('— 未取得'));assert.ok(html.includes('下一步：待核实'));
  assert.ok(html.includes('<details><summary>详细说明'));assert.ok(html.includes('更多数据（2 行）'));
  assert.ok(html.includes('<details><summary>使用指南'));assert.ok(html.includes('「已同步」是读取时间，不是数据时间'));
  view.risk[0].brief.action='buy';assert.throws(()=>renderReport(view,context),/brief action/);
});
test('structured orders are grouped, escaped, fresh-quoted and do not infer cancellation',()=>{
  const view=fixture();view.rotation.columns=[];view.rotation.rows=[];
  const order=(symbol,side,limitPrice)=>({symbol,side,quantity:10,limitPrice,marketPrice:100,currency:'USD',marketAsOfHkt:stamp,ageDays:70,status:'NEW',cancelReview:false});
  view.rotation.orders=[order('SELL','sell',110),order('FAR','buy',80),order('NEAR','buy',99)];
  const html=renderReport(view,context);assert.ok(html.indexOf('1. NEAR')<html.indexOf('2. FAR'));assert.ok(html.indexOf('2. FAR')<html.indexOf('1. SELL'));
  assert.ok(!html.includes('order-review">待撤复核'));assert.ok(html.includes('距离不代表成交概率'));
  const result=runGuard(html);assert.equal(result.status,0,result.stderr);
  view.rotation.orders[0].marketAsOfHkt='2026-08-24 10:00 HKT';assert.throws(()=>renderReport(view,context),/quote must be current/);
});

export { fixture, context };
