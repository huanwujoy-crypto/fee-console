// Synthetic aggregate sources and in-memory IO only. Never a production run.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {authenticated,syntheticOfficialSource} from './fee-ratio-official-source.test.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
import {aggregateUiFixture,aggregateUiStage} from './fee-ratio-aggregate-ui-fixture.mjs';
import {buildRatioModel} from './fee-ratio-packet.mjs';
import {createRatioCloudPublisher,RATIO_CLOUD_FILE} from './fee-ratio-cloud-publish.mjs';
import {readVerifiedBrowserEvidence,consumeBrowserEvidence} from './fee-ratio-browser-evidence.mjs';
import {stageIndependentRatioSnapshot} from './fee-ratio-snapshot-packet.mjs';
const bytes=x=>Buffer.from(JSON.stringify(x)),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const scope=(name,parent=null)=>({type:parent?'fund-strategy':name==='All Together'?'portfolio':'classification',name,parent});
function performance(base){
 const core=createAggregateReturnsCore(),member={account:'Synthetic 2',market:'PRIVATE',securityCode:'SYNTHETIC-CLOSED'};
 return {schema:core.SCHEMA,provider:'Sharesight',currency:'USD',asOf:'2026-10-30',accounts:base.accounts,reports:['all','oneYear'].map((period,i)=>({period,startDate:i?'2025-10-30':'2020-01-02',endDate:'2026-10-30',includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'excluded',source:{libraryFileId:'libfile_'+String(i+4).repeat(32),version:0,sha256:String(i+4).repeat(64),locator:'Native Total cells'},rows:[{scope:scope('常青基金'),members:[member],sourceSheet:'Synthetic group',sourceRow:9,returnPct:i?-2.1:8.25,unit:i?'period':'p.a.',termEvidence:{type:'unknown'}}],unavailable:[{scope:scope('All Together'),reason:'benchmark-members-included'},{scope:scope('未分类','常青基金'),reason:'native-aggregate-not-provided'}]}))};
}
function addInceptionEvidence(raw){
 const source={libraryFileId:'libfile_'+'8'.repeat(32),version:0,sha256:'8'.repeat(64),locator:'Synthetic private inception directory'};
 raw.performance.inceptionEvidence={schema:'fee-console.ratio-inception-source.v1',capturedAt:'2026-10-29T05:00:00.000Z',includeClosed:true,sources:[source],members:[{...raw.performance.reports[0].rows[0].members[0],startDate:'2022-03-04',dateKind:'holding-inception',sourceFileId:source.libraryFileId,sourceLocator:'Synthetic historical member inception_date'}]};
}
async function fixture(t,edit=x=>x,allocation=syntheticOfficialSource()){
 const f=await authenticated(t,allocation),raw={schemaVersion:'sharesight-private-performance-v1',accounts:[...f.raw.accounts],allocation:structuredClone(f.raw),performance:performance(f.raw),performanceCapturedAt:'2026-10-30T05:50:00.000Z'};
 edit(raw,f);const original=bytes(raw),base=createOfficialRatioSourceCore().build(raw.allocation,{sourceSha256:hash(original),sourceBytes:original.length}).input,input={...base,schema:'fee-console.ratio-sources.v3',performance:structuredClone(raw.performance)},inputBytes=bytes(input);
 const facts=f.source.verifyBrowserSourceAssociations(raw,input,{scopeHash:f.scope,now:f.now}),model=await buildRatioModel(input,{kind:'snapshot',targetDate:'2026-10-30',viewCore:f.ratio,previewOnly:true,now:f.now});
 model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-library-association',associationId:'c'.repeat(64),managerScopeId:f.manager.recipient.scopeId,sourceVersion:0,migrationPending:facts.migrationPending,classificationDeltaCents:facts.classificationDeltaCents,exposureDeltaCents:facts.exposureDeltaCents};
 model.companyExposure=facts.companyExposure;model.sourceDates=facts.sourceDates;model.classificationSummary=facts.classificationSummary;
 const args={originalBytes:new Uint8Array(original),inputBytes:new Uint8Array(inputBytes),model,recipient:f.manager.recipient,sourceSha256:hash(original),inputSha256:hash(inputBytes),libraryVersion:0,now:f.now};
 const proof=await f.snapshot.verifyOriginal(args),candidate=await f.snapshot.candidate({model,recipient:f.manager.recipient,proof,previous:f.signed,now:f.now}),signed=await f.snapshot.authenticate(candidate,proof,f.manager,{previous:f.signed,profileSha256:'b'.repeat(64),now:f.now});
 return {...f,raw,input,original,inputBytes,facts,model,args,proof,performanceSigned:signed};
}
test('native aggregates bind to original bytes, encrypt, authenticate, reopen and render without individual rates',async t=>{
 const f=await fixture(t),r=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(r.model);
 assert.equal(r.source.sourceDates.performance,'2026-10-30');assert.deepEqual(r.model.performance,f.raw.performance);assert.match(html,/收益截至 2026-10-30/);assert.match(html,/8.25%/);assert.match(html,/年化/);assert.match(html,/-2.10%/);assert.match(html,/虚拟持仓/);assert.doesNotMatch(html,/SYNTHETIC-CLOSED/);
 assert.equal(r.model.feeCalculationReceipt,undefined);assert.deepEqual(r.model.classificationSummary,f.built.input.classification);assert.deepEqual(r.model.book.holdings,f.model.book.holdings);assert.equal(r.source.capturedAt,f.signed.body.source.capturedAt);
 const holdings=html.match(/<li class="ratio-fund-holding"[^]*?<\/li>/g)||[];assert.ok(holdings.every(x=>!x.includes('ratio-returns')));
});
test('tampered return, missing return source, fabricated proof and account mismatch cannot obtain publication proof',async t=>{
 const f=await fixture(t);
 for(const change of [m=>m.performance.reports[0].rows[0].returnPct++,m=>delete m.performance,m=>m.performance.accounts.pop(),m=>m.sourceDates.performance='2026-10-29']){const model=structuredClone(f.model);change(model);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));}
 const input=structuredClone(f.input);input.performance.reports[0].rows[0].returnPct++;const changed=bytes(input);await assert.rejects(f.snapshot.verifyOriginal({...f.args,inputBytes:new Uint8Array(changed),inputSha256:hash(changed)}));
 await assert.rejects(f.snapshot.candidate({model:f.model,recipient:f.manager.recipient,proof:structuredClone(f.proof),now:f.now}));
});
test('inception metadata follows original association, encryption and readback without changing financial dates',async t=>{
 const f=await fixture(t,addInceptionEvidence),r=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now});
 assert.deepEqual(r.model.performance.inceptionEvidence,f.raw.performance.inceptionEvidence);assert.deepEqual(r.model.sourceDates,f.model.sourceDates);assert.equal(r.source.capturedAt,f.signed.body.source.capturedAt);
 assert.equal(r.model.performance.reports[0].startDate,'2020-01-02');const core=createAggregateReturnsCore(),view=core.build(r.model.performance,{expectedAccounts:r.model.performance.accounts,expectedAsOf:'2026-10-30'}),html=core.renderInline(core.select(view,scope('常青基金')));assert.match(html,/全部：<\/strong>2022-03-04 至 2026-10-30/);assert.match(html,/近一年：<\/strong>2025-10-30 至 2026-10-30/);assert.match(f.ratio.render(r.model),/8.25%/);
 assert.doesNotMatch(html,/Synthetic historical member inception_date|libfile_8888/);
 for(const change of [e=>e.members[0].startDate='2023-01-02',e=>e.members[0].account='Synthetic 3',e=>e.sources[0].sha256='f'.repeat(64),e=>e.members.pop()]){
  const model=structuredClone(f.model);change(model.performance.inceptionEvidence);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));
  const input=structuredClone(f.input);change(input.performance.inceptionEvidence);const inputBytes=bytes(input);await assert.rejects(f.snapshot.verifyOriginal({...f.args,inputBytes:new Uint8Array(inputBytes),inputSha256:hash(inputBytes)}));
 }
 const raw=structuredClone(f.raw);raw.performance.inceptionEvidence.members[0].startDate='2023-01-02';await assert.rejects(f.snapshot.verifyOriginal({...f.args,originalBytes:new Uint8Array(bytes(raw))}));
 const model=structuredClone(f.model);delete model.performance.inceptionEvidence;await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));
});
test('performance evidence cannot refresh old allocation capture or use future/old returns',async t=>{
 for(const edit of [r=>r.performanceCapturedAt='2026-11-01T00:00:00.000Z',r=>r.performanceCapturedAt='2026-10-27T00:00:00.000Z',r=>r.performance.asOf='2026-10-31',r=>r.accounts.reverse()])await assert.rejects(fixture(t,edit));
});
test('accepted native benchmark scope survives authentication and discloses without changing allocation',async t=>{
 const allocation=JSON.parse(JSON.stringify(syntheticOfficialSource()).replaceAll('Synthetic 7','Citi-HK & 地产四期'));
 const f=await fixture(t,r=>{for(const p of r.performance.reports){p.rows[0].scope=scope('All Together');p.rows[0].members.push({account:r.accounts[9],market:'NASDAQ',securityCode:'QQQ'});p.unavailable=p.unavailable.filter(x=>x.scope.name!=='All Together');}},allocation);
 const reopened=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(reopened.model);
 assert.match(html,/总资产收益含 1 项程序取值模拟基准/);assert.match(html,/资产配置已排除它们，口径不同/);assert.match(html,/8.25%/);
 assert.deepEqual(reopened.model.classificationSummary,f.built.input.classification);assert.deepEqual(reopened.model.book.holdings,f.model.book.holdings);
 assert.deepEqual(reopened.model.performance,f.raw.performance);assert.equal(reopened.model.feeCalculationReceipt,undefined);
});
test('valid legacy allocation with performance retains exactly one common return explanation',async t=>{
 const f=await fixture(t),legacy=structuredClone(f.model);delete legacy.classificationSummary.assetAllocation;
 const before=structuredClone(legacy);await f.ratio.validateModel(legacy);const html=f.ratio.render(legacy);
 assert.match(html,/四类资产配置总览/);assert.doesNotMatch(html,/ratio-six-allocation/);
 assert.equal((html.match(/class="ratio-overview-return-notes"/g)||[]).length,1);
 assert.match(html,/官方原值，含已平仓/);assert.match(html,/不平均百分比、不按当前市值加权重算/);
 assert.match(html,/无标记时未确认年化/);assert.match(html,/不代表0%/);assert.deepEqual(legacy,before);
});
test('valid legacy allocation without performance adds no return explanation or invented data',async t=>{
 const f=await authenticated(t),legacy=structuredClone(f.model);delete legacy.classificationSummary.assetAllocation;
 const before=structuredClone(legacy);await f.ratio.validateModel(legacy);const html=f.ratio.render(legacy);
 assert.match(html,/四类资产配置总览/);assert.equal((html.match(/class="ratio-overview-return-notes"/g)||[]).length,0);
 assert.doesNotMatch(html,/ratio-return-compact|ratio-return-facts|ratio-total-returns/);assert.deepEqual(legacy,before);
});
test('legacy benchmark note never claims excluded allocation when the historical basis retains it',async t=>{
 const allocation=JSON.parse(JSON.stringify(syntheticOfficialSource()).replaceAll('Synthetic 7','Citi-HK & 地产四期'));
 const f=await fixture(t,r=>{for(const p of r.performance.reports){p.rows[0].scope=scope('All Together');p.rows[0].members.push({account:r.accounts[9],market:'NASDAQ',securityCode:'QQQ'});p.unavailable=p.unavailable.filter(x=>x.scope.name!=='All Together');}},allocation);
 const legacy=structuredClone(f.model);delete legacy.classificationSummary.assetAllocation;legacy.classificationSummary.basis='complete-official-classification-row-sum';
 const before=structuredClone(legacy);await f.ratio.validateModel(legacy);const html=f.ratio.render(legacy);
 assert.equal((html.match(/class="ratio-overview-return-notes"/g)||[]).length,1);
 assert.match(html,/总资产收益含 1 项程序取值模拟基准/);assert.match(html,/此历史快照的资产总额保留原口径/);
 assert.doesNotMatch(html,/资产配置已排除它们|配置比例仍排除/);assert.deepEqual(legacy,before);
 const excluded=structuredClone(legacy);excluded.classificationSummary.basis='complete-official-classification-excluding-benchmark-only.v1';await f.ratio.validateModel(excluded);
 assert.match(f.ratio.render(excluded),/资产配置已排除它们，口径不同/);
});

function addTopReturns(raw,f){
 const core=createAggregateReturnsCore(),companies=createFeeCompanyExposureCore().validate(f.model.companyExposure,f.model.exposure,f.model.book.sourceSha256).top;
 const targets=core.topTargets(f.model.exposure,companies);
 raw.performance.topHoldings={schema:'fee-console.ratio-top5-source.v1',targets,reports:raw.performance.reports.map(r=>({...structuredClone(r),additionalSources:[],rows:targets.filter(t=>t.members.length).map((t,i)=>({target:{category:t.category,name:t.name},memberEvidence:t.members.map((m,n)=>({...m,name:t.name,category:t.category,sourceRow:100+i*10+n})),sourceSheet:'Synthetic official subtotal '+i,sourceRow:100+i*10,returnPct:7.62+i,unit:'unknown',termEvidence:{type:'unknown'}})),unavailable:targets.filter(t=>!t.members.length).map(t=>({target:{category:t.category,name:t.name},reason:'no-direct-holding'}))}))};
}
function addStockReturns(raw){
 for(const [i,r]of raw.performance.reports.entries()){
  const ref=n=>({libraryFileId:'libfile_'+n.repeat(32),version:0,sha256:n.repeat(64),locator:'Synthetic native grouping'});
  r.additionalSources=[ref(String(i+6)),ref(String(i+8))];
  r.rows[0].sourceFileId=r.additionalSources[0].libraryFileId;
  const rows=['美国底仓','美国科技','非美发达','新兴市场'].map((name,j)=>({scope:scope(name),members:[{account:raw.accounts[j],market:'SYNTHETIC',securityCode:'STOCK-'+j}],sourceSheet:'Synthetic original stock category',sourceRow:20+j,returnPct:10+j,unit:'unknown',termEvidence:{type:'unknown'}}));
  r.rows.push(...rows,{scope:scope('股票市场'),members:structuredClone(rows.flatMap(row=>row.members)),sourceFileId:r.additionalSources[1].libraryFileId,sourceSheet:'Synthetic native stock subtotal',sourceRow:90,returnPct:i?-2.43:17.23,unit:'unknown',termEvidence:{type:'unknown'}});
 }
}
test('official stock subtotal authenticates and renders without replacing allocation or top-five evidence',async t=>{
 const f=await fixture(t,(raw,f)=>{addTopReturns(raw,f);addStockReturns(raw);}),reopened=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(reopened.model);
 assert.deepEqual(reopened.model.performance,f.raw.performance);assert.deepEqual(reopened.model.performance.topHoldings,f.raw.performance.topHoldings);
 assert.deepEqual(reopened.model.classificationSummary,f.built.input.classification);assert.deepEqual(reopened.model.book.holdings,f.model.book.holdings);assert.deepEqual(reopened.model.companyExposure,f.model.companyExposure);
 const overview=html.slice(html.indexOf('<table class="ratio-overview-table">'),html.indexOf('</table>',html.indexOf('<table class="ratio-overview-table">')));
 assert.match(overview,/17.23%/);assert.match(overview,/-2.43%/);assert.doesNotMatch(overview,/17.23% p.a.|未满一年/);
 assert.match(html,/7.62%/);assert.match(html,/8.25%/);
 for(const change of [m=>m.performance.reports[0].rows.at(-1).returnPct++,m=>m.performance.reports[0].additionalSources[1].sha256='a'.repeat(64),m=>m.performance.reports[0].rows.at(-1).members.pop()]){const bad=structuredClone(f.model);change(bad);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:bad}));}
});
test('top-five actual selected scopes survive original proof, encryption, authentication and reopen',async t=>{
 const f=await fixture(t,addTopReturns),reopened=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(reopened.model);
 assert.deepEqual(reopened.model.performance.topHoldings,f.raw.performance.topHoldings);
 assert.match(html,/直接持仓收益率/);assert.match(html,/7.62%/);assert.match(html,/不包括 ETF 穿透公司敞口/);
 const fundDetails=html.match(/<li class="ratio-fund-holding"[^]*?<\/li>/g)||[];assert.ok(fundDetails.every(x=>!x.includes('ratio-returns')));
 assert.deepEqual(reopened.model.classificationSummary,f.model.classificationSummary);assert.deepEqual(reopened.model.companyExposure,f.model.companyExposure);
 for(const change of [m=>m.performance.topHoldings.reports[0].rows[0].returnPct++,m=>m.performance.topHoldings.targets[0].members[0].account='Wrong account']){const bad=structuredClone(f.model);change(bad);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:bad}));}
});
test('wrong ranked membership or invented sixth entry fails original association',async t=>{
 for(const change of [raw=>raw.performance.topHoldings.targets[0].name='Other fund',raw=>raw.performance.topHoldings.targets.push(structuredClone(raw.performance.topHoldings.targets[0]))])await assert.rejects(fixture(t,(raw,f)=>{addTopReturns(raw,f);change(raw);}));
});
test('compact overview retains exact dollars, native returns and distinct six-class scope',async t=>{
 const f=await fixture(t),html=f.ratio.render(f.model);
 assert.match(html,/<th>市值（USD）<\/th><th>收益率<\/th>/);assert.match(html,/全部：/);assert.match(html,/近一年：/);assert.match(html,/<details class="ratio-overview-return-notes"><summary>收益说明<\/summary>/);assert.match(html,/二级市场整体收益/);assert.match(html,/不等于上方股票市场子集/);assert.doesNotMatch(html,/M＝百万美元|ratio-money-exact|ratio-performance-overview|<h2>投资收益率/);
 const m=structuredClone(f.model);m.classificationSummary.assetAllocation.groups[0].valueCents=1725250072;
 const before=structuredClone(m),exact=f.ratio.render(m);assert.match(exact,/<span class="ratio-money-precise">17,252,500\.72<\/span>/);assert.doesNotMatch(exact,/17.25M/);assert.deepEqual(m,before,'display cannot change amounts, returns or source evidence');
 for(const [valueCents,label]of [[1,'0.01'],[0,'0.00'],[99999999999999,'999,999,999,999.99'],[100000000000000,'1,000,000,000,000.00']]){m.classificationSummary.assetAllocation.groups[0].valueCents=valueCents;assert.ok(f.ratio.render(m).includes('<span class="ratio-money-precise">'+label+'</span>'));}
 const overview=exact.slice(exact.indexOf('<table class="ratio-overview-table">'),exact.indexOf('</table>',exact.indexOf('<table class="ratio-overview-table">')));
 assert.equal((overview.match(/class="ratio-money-precise"/g)||[]).length,6);assert.equal((overview.match(/class="ratio-return-compact-line"/g)||[]).length,12);assert.doesNotMatch(overview,/<tfoot>/);
 const total=exact.split('<div class="ratio-total-summary">')[1].split('<div class="ratio-overview-disclosures">')[0];
 assert.equal((total.match(/class="ratio-money-precise"/g)||[]).length,1);assert.equal((total.match(/class="ratio-return-compact-line"/g)||[]).length,2);
 assert.match(total,/<h3>总资产（USD）<\/h3>/);assert.match(total,/收益率 \/ 收益金额（USD）/);
 assert.doesNotMatch(overview,/<small>原报表口径|<small>暂无官方小计/);assert.match(exact,/无标记时未确认年化/);assert.match(exact,/不代表0%/);
});
test('overview numbers its evidence and shares one control row without adding IB-only or detail holding rates',async t=>{
 const f=await fixture(t,addTopReturns),before=structuredClone(f.model),html=f.ratio.render(f.model);
 const numbered=html.match(/<ol class="ratio-return-note-list">([^]*?)<\/ol>/);assert.ok(numbered);
 assert.match(numbered[1],/官方原值，含已平仓/);assert.match(numbered[1],/不平均百分比、不按当前市值加权重算/);assert.match(numbered[1],/仅凭官方证据标注年化、期间收益或未满一年/);assert.match(numbered[1],/不代表0%/);assert.match(numbered[1],/直接持仓收益，不含 ETF 穿透敞口，也不乘杠杆倍数/);
 assert.equal((numbered[1].match(/含已平仓/g)||[]).length,1,'common closed-holding rule appears once');
 assert.match(html,/<div class="ratio-overview-disclosures"><details class="ratio-overview-return-notes">/);
 const start=html.indexOf('class="ratio-overview-disclosures"'),end=html.indexOf("<section class=\"card sharesight-exposure\"",start),overview=html.slice(start,end);
 assert.match(overview,/<details class="ratio-asset-notes">/);assert.doesNotMatch(overview,/<details[^>]*open/);
 const top=html.split('<section class="card sharesight-exposure">')[1].split('<section class="card ratio-stock-allocation">')[0];assert.equal((top.match(/class="ratio-returns-inline"/g)||[]).length,20);assert.equal((top.match(/class="ratio-return-compact-line"/g)||[]).length,40);
 const stock=html.split('<section class="card ratio-stock-allocation">')[1].split('</section>')[0];assert.match(stock,/仅\s*IB-HK/);assert.doesNotMatch(stock,/ratio-return|收益率/);
 const funds=html.match(/<li class="ratio-fund-holding"[^]*?<\/li>/g)||[];assert.ok(funds.length>0);assert.ok(funds.every(s=>!s.includes('ratio-return')));
 const bars=html.match(/<div class="ratio-distribution-row">[^]*?<div class="ratio-returns-inline">/g)||[];assert.ok(bars.length>=2,'each existing strategy receives its own inline native scope');assert.deepEqual(f.model,before);
});
test('shared controls reserve touch space while open text keeps full width; compact rates may wrap',()=>{
 const actual=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),page=hash(actual)===aggregateUiFixture.nextSha256?actual:aggregateUiStage(actual);
 assert.match(page,/\.ratio-overview-disclosures\{position:relative;padding-top:44px;[^}]*min-width:0/);
 assert.match(page,/\.ratio-overview-disclosures>details>summary\{position:absolute;top:0;left:0;[^}]*width:calc\(50% - 6px\);min-height:44px/);
 assert.match(page,/\.ratio-overview-disclosures>\.ratio-asset-notes>summary\{left:calc\(50% \+ 6px\)\}/);
 assert.match(page,/\.ratio-overview-disclosures>details:only-child>summary\{left:0\}/);
 assert.match(page,/\.ratio-returns-inline \.ratio-return-compact-line\{overflow-wrap:anywhere\}/);
 assert.doesNotMatch(page,/\.ratio-overview-disclosures>details\{[^}]*(?:width:50%|position:absolute)/,'open details stay normal flow at full container width');
});
test('fund amounts precede percentages and stock allocation uses its own source date',async t=>{
 const f=await fixture(t),m=structuredClone(f.model);
 m.book.asOf='2026-10-29';
 const before=structuredClone(m),html=f.ratio.render(m);
 const stock=html.split('<section class="card ratio-stock-allocation">')[1].split('</section>')[0];
 assert.match(stock,/<p class="ratio-stock-asof">数据截至 2026-10-29<\/p>/);
 assert.doesNotMatch(stock,/数据截至 2026-10-30/,'exposure and performance dates cannot replace the allocation source date');
 for(const fund of m.classificationSummary.fundDistributions){
  for(const group of fund.groups){
   const amount=(group.valueCents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
   assert.ok(html.includes('<span class="ratio-distribution-values"><span class="ratio-distribution-metric ratio-distribution-market-value"><small>当前市值（USD）</small><span class="ratio-distribution-amount"><span class="ratio-money-precise">'+amount+'</span></span></span><span class="ratio-distribution-metric ratio-distribution-weight"><small>占比</small><strong>'));
  }
 }
 const noBook=structuredClone(m);noBook.book=null;
 const absent=f.ratio.render(noBook).split('<section class="card ratio-stock-allocation">')[1].split('</section>')[0];
 assert.match(absent,/数据截至 未取得/);assert.match(absent,/完整分类持仓未取得/);
 assert.deepEqual(m,before,'displaying source amounts and dates cannot change the model');
});
test('only total assets show same-row official period amounts and authenticated changes fail closed',async t=>{
 const f=await fixture(t,raw=>{for(const [i,r] of raw.performance.reports.entries()){
  r.unavailable=r.unavailable.filter(x=>x.scope.name!=='All Together');
  r.rows.push({...structuredClone(r.rows[0]),scope:scope('All Together'),sourceRow:20,returnPct:i?4.5:6.75,returnAmountUSD:i?0:-12345.67});
 }}),before=structuredClone(f.model),html=f.ratio.render(f.model);
 const total=html.split('<div class="ratio-total-summary">')[1].split('<div class="ratio-overview-disclosures">')[0];
 assert.match(total,/>收益 -12,345\.67<\/span>/);assert.match(total,/>收益 0\.00<\/span>/);assert.doesNotMatch(total,/>收益 USD/);
 assert.match(total,/aria-label="全部：6\.75%；[^\"]+；收益 USD -12,345\.67/);assert.match(total,/aria-label="近一年：4\.50%；[^\"]+；收益 USD 0\.00/);
 assert.equal((html.match(/class="ratio-return-amount"/g)||[]).length,2);
 assert.match(html,/美元期间收益，非年化金额/);assert.deepEqual(f.model,before);
 const changed=structuredClone(f.model);changed.performance.reports[0].rows.at(-1).returnAmountUSD++;
 await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:changed}));
 const legacy=await fixture(t),oldHtml=legacy.ratio.render(legacy.model);
 assert.equal((oldHtml.match(/class="ratio-return-amount"[^>]*>收益 —/g)||[]).length,2,'old snapshots show absent amounts, never invented zero');
});
test('fund and top-five periods share two flexible columns without changing overview or source disclosure layout',()=>{
 const actual=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),page=hash(actual)===aggregateUiFixture.nextSha256?actual:aggregateUiStage(actual);
 const css=page.split('<style>')[1].split('</style>')[0],lastRule=selector=>{assert.ok(css.includes(selector+'{'),'missing selector '+selector);return css.split(selector+'{').at(-1).split('}')[0];};
 const rates=lastRule('.ratio-fund-distribution .ratio-returns-inline>.ratio-return-compact,.ratio-holding-row .ratio-returns-inline>.ratio-return-compact');
 assert.match(rates,/display:grid/);assert.match(rates,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);assert.match(rates,/width:100%/);
 assert.match(page,/\.ratio-fund-distribution \.ratio-return-compact-line,\.ratio-holding-row \.ratio-return-compact-line\{min-width:0;overflow-wrap:anywhere\}/);
 const values=lastRule('.ratio-distribution-values');assert.match(values,/display:grid/);assert.match(values,/grid-template-columns:minmax\(0,1fr\) auto/);assert.match(values,/width:100%/);
 const labeled=lastRule('.ratio-fund-distribution .ratio-returns-inline,.ratio-holding-row .ratio-returns-inline');assert.match(labeled,/display:grid/);assert.match(labeled,/grid-template-columns:auto minmax\(0,1fr\)/);
 const facts=lastRule('#p-ratio .ratio-fund-distribution .ratio-returns-inline>.ratio-return-facts,#p-ratio .ratio-holding-row .ratio-returns-inline>.ratio-return-facts');assert.match(facts,/grid-column:1\/-1/);assert.match(facts,/width:100%/);
 assert.match(page,/\.ratio-return-amount\{display:block;[^}]*overflow-wrap:anywhere/);
 assert.doesNotMatch(page,/\.ratio-return-amount\{[^}]*(?:text-overflow:ellipsis|overflow:hidden)/);
 // At a 390px viewport, both periods share the content width; long Chinese
 // labels, signed rates and the existing under-one-year badge may wrap inside
 // their own column, rather than hiding evidence or moving a period below it.
 assert.match(page,/\.ratio-return-compact-line small\{display:inline;[^}]*font-size:10px/);
});
test('prior performance date cannot disappear through a later signed legacy snapshot',async t=>{
 const f=await fixture(t),oldProof=await f.snapshot.verifyOriginal(f.args);
 const legacy=f.signed,older=legacy.body.source,raw=structuredClone(f.raw.allocation),original=bytes(raw),base=createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(original),sourceBytes:original.length}).input;
 const m=structuredClone(f.model);delete m.performance;delete m.sourceDates.performance;m.book.sourceSha256=hash(original);m.book.browserEvidence.fullSourceSha256=hash(original);m.book.browserEvidence.fullSourceBytes=original.length;m.companyExposure=f.source.verifyBrowserSourceAssociations(raw,base,{scopeHash:f.scope,now:f.now}).companyExposure;
 const ib=bytes(base),proof=await f.snapshot.verifyOriginal({originalBytes:new Uint8Array(original),inputBytes:new Uint8Array(ib),model:m,recipient:f.manager.recipient,sourceSha256:hash(original),inputSha256:hash(ib),libraryVersion:0,now:f.now}),candidate=await f.snapshot.candidate({model:m,recipient:f.manager.recipient,proof,previous:f.performanceSigned,now:f.now});
 await assert.rejects(f.snapshot.authenticate(candidate,proof,f.manager,{previous:f.performanceSigned,profileSha256:'d'.repeat(64),now:f.now}));
 const current=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now});await assert.rejects(f.snapshot.verify(legacy,f.manager,{now:f.now,watermark:current.watermark}));
});
test('aggregate-only cloud path keeps one fixed-file write, readback and pinned cleanup',async t=>{
 const f=await fixture(t,raw=>{addInceptionEvidence(raw);for(const [i,r]of raw.performance.reports.entries()){const id=String(i+6);r.additionalSources=[{libraryFileId:'libfile_'+id.repeat(32),version:0,sha256:id.repeat(64),locator:'Synthetic auxiliary original'}];r.rows[0].sourceFileId=r.additionalSources[0].libraryFileId;}}),bundleId=hash(Buffer.concat([f.original,f.inputBytes])),prefix='inputs/'+bundleId+'/',plan={mode:'publish',previousBodySha256:await f.ratio.digest(f.signed.body),bundleId,original:{name:prefix+'original.json',generation:'1',sha256:hash(f.original)},input:{name:prefix+'input.json',generation:'2',sha256:hash(f.inputBytes)},library:{fileId:'libfile_'+'9'.repeat(32),version:0},fee:{mainSha:'e'.repeat(40),accountingThrough:'2026-11-05',dataSha256:'1'.repeat(64),healthSha256:'2'.repeat(64)}},identity={gistId:'0'.repeat(32),ownerId:42};
 let current=bytes(f.signed),patches=0,claimed=0,deleted=0,feeChecks=0;const io={
 async readDestination(name){assert.equal(name,RATIO_CLOUD_FILE);return {id:identity.gistId,ownerId:42,authenticatedUserId:42,public:false,revision:(patches?'b':'a').repeat(40),recipientBytes:bytes(f.manager.recipient),snapshotBytes:Buffer.from(current)};},
 async readInput(s){return {generation:s.generation,bytes:Buffer.from(s.name.endsWith('original.json')?f.original:f.inputBytes)};},
 async claimOnce(k,b,options){assert.deepEqual(options,{ifGenerationMatch:0});return ++claimed===1?'CREATED':'EXISTS';},
 async patchSnapshot(body){assert.deepEqual(Object.keys(body.files),[RATIO_CLOUD_FILE]);patches++;current=Buffer.from(body.files[RATIO_CLOUD_FILE].content);},
 async saveReceipt(){},async cleanupLocal(){},async deleteInputs(specs){assert.deepEqual(specs,[plan.original,plan.input]);deleted++;},
 // Synthetic stand-in for the verified fee-first handoff; the gate itself is tested separately.
 async verifyFeePublication({handoff}){feeChecks++;return Object.freeze({accountingThrough:handoff.accountingThrough,feeMainSha:handoff.mainSha,dataSha256:handoff.dataSha256,healthSha256:handoff.healthSha256,verifiedAt:f.now.toISOString(),healthCheckedAt:'2026-10-28T00:00:00.000Z'});}};
 const result=await createRatioCloudPublisher({exposureCore:f.exposure}).run({plan,identity,manager:f.manager,io,clock:()=>f.now});
 assert.equal(result.status,'PUBLISHED_CONFIRMED');assert.equal(patches,1);assert.equal(claimed,1);assert.equal(deleted,1);assert.equal(feeChecks,2);
 const accepted=await f.snapshot.verify(JSON.parse(current),f.manager,{now:f.now});assert.deepEqual(accepted.model.performance,f.raw.performance);
 const tampered=structuredClone(f.model);tampered.performance.reports[0].additionalSources[0].sha256='e'.repeat(64);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:tampered}));
});
test('browser uses exact tested factories and preserves existing note/session code',()=>{
 const actual=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 // The required support-only PR leaves the prior page intact. Accept only
 // either exact reviewed page, and prove the frozen transition before use.
 assert.ok([aggregateUiFixture.priorSha256,aggregateUiFixture.supportSha256,aggregateUiFixture.nextSha256].includes(hash(actual)));
 const page=hash(actual)!==aggregateUiFixture.nextSha256?aggregateUiStage(actual):actual;
 const css=page.split('<style>')[1].split('</style>')[0];
 assert.doesNotMatch(css,/\\n/,'stylesheet must contain actual newlines, not escaped selector prefixes');
 assert.match(css,/(?:^|\n)\.ratio-overview-table\{width:100%;table-layout:fixed\}/);
 assert.match(css,/#p-ratio \.ratio-overview-table th:first-child,#p-ratio \.ratio-overview-table td:first-child\{width:24%\}/);assert.match(css,/#p-ratio \.ratio-overview-table th:nth-child\(2\),#p-ratio \.ratio-overview-table td:nth-child\(2\)\{width:39%\}/);assert.match(css,/#p-ratio \.ratio-overview-table th:nth-child\(3\),#p-ratio \.ratio-overview-table td:nth-child\(3\)\{width:37%\}/);
 assert.match(css,/\.ratio-money-precise\{[^}]*font-variant-numeric:tabular-nums;overflow-wrap:anywhere\}/);assert.doesNotMatch(css,/\.ratio-money-precise\{[^}]*(?:text-overflow:ellipsis|overflow:hidden)/);
 assert.match(css,/#fundInvestorBox \.kpi:not\(\.wide\) \.val\{white-space:nowrap;font-size:clamp\(16px,4.5vw,22px\)\}/);
 assert.match(css,/@media\(max-width:360px\)\{#fundInvestorBox \.kpis\{grid-template-columns:1fr\}/);
 for(const file of ['fee-ratio-aggregate-returns','fee-ratio-management','fee-ratio-source-core','fee-ratio-snapshot']){const code=fs.readFileSync(new URL('./'+file+'.mjs',import.meta.url),'utf8'),factory=code.slice(code.indexOf('export function ')).replace('export function ','function ').trim();assert.ok(page.includes(factory),file);}
 assert.match(page,/summary\?\.textContent==='分类、账户与参考目标'/);assert.match(page,/summary\.textContent='明细'/);assert.match(page,/createAggregateReturnsCore\.toString\(\)/);
});
test('local private handoff deeply freezes returns and stages a candidate with the authenticated source',async t=>{
 const f=await fixture(t),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ratio-performance-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name,value)=>{const b=Buffer.isBuffer(value)?value:bytes(value),file=path.join(dir,name);fs.writeFileSync(file,b,{mode:0o600});return {path:file,sha256:hash(b)};};
 const plan={schema:'fee-console.ratio-browser-evidence-plan.v1',workspace:dir,source:write('original.json',f.original),input:write('input.json',f.inputBytes),library:{libraryFileId:'libfile_'+'9'.repeat(32),version:0},managerScopeId:f.manager.recipient.scopeId,localOwnerUid:process.getuid()};
 const evidence=write('evidence.json',plan),runtime={uid:process.getuid(),readIdentity:()=>({libraryFileId:plan.library.libraryFileId,version:0})};
 const proof=readVerifiedBrowserEvidence({planPath:evidence.path,expectedScopeId:f.manager.recipient.scopeId,input:f.input,now:f.now,runtime,exposureCore:f.exposure});
 assert.throws(()=>{proof.performance.reports[0].rows[0].returnPct=999;},TypeError);
 const copied=consumeBrowserEvidence(proof,f.input,f.manager.recipient.scopeId,f.now);assert.deepEqual(copied.performance,f.raw.performance);copied.performance.reports[0].rows[0].returnPct=999;assert.notEqual(proof.performance.reports[0].rows[0].returnPct,999);
 const result=await stageIndependentRatioSnapshot({plan:{schema:'fee-console.ratio-snapshot-plan.v1',workspace:dir,evidence,recipient:write('recipient.json',f.manager.recipient),previous:write('previous.json',f.signed)},now:f.now,environ:{},evidenceRuntime:runtime,exposureCore:f.exposure});
 assert.equal(result.status,'RATIO_INDEPENDENT_CANDIDATE_ONLY');assert.equal(result.publicationReady,false);assert.equal(result.managerAuthentication,false);assert.equal(result.financialRead,false);assert.equal(result.feeOrHealthWrite,false);
 const packet=JSON.parse(fs.readFileSync(path.join(dir,'ratio-independent-candidate','fee-console-ratio-snapshot.candidate.json'),'utf8'));assert.equal(packet.body.source.sourceDates.performance,'2026-10-30');
});

// Minimal DOM with normal move semantics. Exercise the actual browser card
// transformation after rendering, rather than checking pre-transform HTML.
class PresentationNode {
 constructor(tag=null,text=''){this.tagName=tag?.toUpperCase();this.nodeType=tag?1:3;this.data=text;this.childNodes=[];this.parentNode=null;this.className='';this.dataset={};this.title='';}
 get children(){return this.childNodes.filter(n=>n.nodeType===1);}
 get firstChild(){return this.childNodes[0]||null;}
 get lastElementChild(){return this.children.at(-1)||null;}
 get nextSibling(){return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]||null;}
 get textContent(){return this.nodeType===3?this.data:this.childNodes.map(n=>n.textContent).join('');}
 set textContent(s){if(this.nodeType===3){this.data=String(s);return;}for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];if(s!=='')this.append(new PresentationNode(null,String(s)));}
 get classList(){const node=this;return {contains:c=>node.className.split(/\s+/).includes(c),add(c){node.className=[...new Set([...node.className.split(/\s+/).filter(Boolean),c])].join(' ');}};}
 append(...nodes){for(const n of nodes){if(n.parentNode)n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n),1);n.parentNode=this;this.childNodes.push(n);}}
 insertBefore(n,before){if(!before){this.append(n);return;}if(n.parentNode)n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n),1);const at=this.childNodes.indexOf(before);assert.ok(at>=0);n.parentNode=this;this.childNodes.splice(at,0,n);}
 replaceWith(n){const p=this.parentNode;assert.ok(p);p.insertBefore(n,this);p.childNodes.splice(p.childNodes.indexOf(this),1);this.parentNode=null;}
 matches(s){return s.startsWith('.')?this.classList.contains(s.slice(1)):this.tagName===s.toUpperCase();}
 querySelectorAll(s){return this.children.flatMap(n=>[...(n.matches(s)?[n]:[]),...n.querySelectorAll(s)]);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 closest(s){for(let n=this;n;n=n.parentNode)if(n.matches(s))return n;return null;}
 get tHead(){return this.children.find(n=>n.tagName==='THEAD');}
 get tBodies(){return this.children.filter(n=>n.tagName==='TBODY');}
 get rows(){return this.children.filter(n=>n.tagName==='TR');}
 get cells(){return this.children.filter(n=>['TH','TD'].includes(n.tagName));}
}
function presentationFixture({returns=true,reverse=false,extra=false,inline=true}={}){
 const el=(tag,cls='',text='')=>{const n=new PresentationNode(tag);n.className=cls;n.textContent=text;return n;};
 const root=el('div'),report=el('div','ratio-report'),overview=el('section','ratio-asset-overview'),exposure=el('section','sharesight-exposure'),originals=[];
 root.append(report);report.append(overview,exposure);overview.append(el('h2','','Synthetic overview'));exposure.append(el('h2','','Synthetic top twenty'));
 const overviewNotes=el('div','ratio-overview-disclosures');overviewNotes.append(el('details','ratio-overview-return-notes','Synthetic return explanation'),el('details','ratio-asset-notes','Synthetic account detail'));overview.append(overviewNotes);
 for(const [category,group]of ['PE/VC','对冲基金','常青基金','二级市场'].entries()){
  const section=el('section'),table=el('table'),head=el('thead'),hrow=el('tr'),body=el('tbody');
  section.append(el('h3','',group),table);table.append(head,body);head.append(hrow);hrow.append(el('th','','名称'),el('th','','金额'),el('th','','占总资产／占本类资产'));exposure.append(section);
  for(let i=0;i<5;i++){
   const row=el('tr'),name=el('td'),amount=el('td','',String(1000+category*100+i)),weight=el('td','','1.25%／4.50%'),account=el('span','ratio-holding-accounts','Synthetic account '+category),disclosures=[];
   name.dataset.securityCode='SYNTH-'+category+'-'+i;name.append(new PresentationNode(null,(i+1)+'. Synthetic product '+category+'-'+i),account);row.append(name,amount,weight);body.append(row);
   let composition=null,rate=null;
   if(category===3||category===2&&i<3){composition=el('details');const list=el('ul');list.append(el('li','','Synthetic member A'),el('li','','Synthetic member B'));composition.append(el('summary','',category===3?'持仓与穿透明细':'合并持仓 · 2笔'),list);disclosures.push(composition);}
   if(returns){const evidence=el('details',inline?'ratio-returns ratio-return-facts':'ratio-returns');evidence.append(el('summary','',inline?'详情':category===3?'直接持仓收益率':'收益率'));
    if(inline)evidence.append(el('p','ratio-return-date-fact','全部：2020-01-02 至 2026-10-30'),el('p','ratio-return-date-fact','近一年：2025-10-30 至 2026-10-30'),el('p','ratio-return-scope-fact','Synthetic account '+category));
    else{const pair=el('div','ratio-return-pair');pair.append(el('div','ratio-return-period','All '+(7.5+category+i)+'% 原报表口径'),el('div','ratio-return-period','近12个月 '+(-2.5+i)+'% 未满一年'));evidence.append(pair);}
    rate=evidence;
    if(inline){rate=el('div','ratio-returns-inline');const compact=el('div','ratio-return-compact');compact.append(el('span','ratio-return-compact-line','全部：'+(7.5+category+i)+'%'),el('span','ratio-return-compact-line','近一年：'+(-2.5+i)+'% 未满一年'));rate.append(el('p','ratio-return-inline-label',category===3?'直接持仓收益率':'收益率'));rate.append(compact,evidence);}disclosures.push(rate);}
   if(reverse)disclosures.reverse();if(extra){const note=el('details','synthetic-note');note.append(el('summary','','Extra preserved note'),el('p','','Synthetic note body'));disclosures.push(note);}
   name.append(...disclosures);originals.push({section,account,composition,rate,disclosures,amount:amount.textContent,weights:weight.textContent,rateText:rate?.textContent,category});
  }
 }
 return {root,report,overview,overviewNotes,exposure,originals,document:{createElement:tag=>el(tag)}};
}
function actualPresentation(f){
 const actual=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),page=hash(actual)===aggregateUiFixture.nextSha256?actual:aggregateUiStage(actual);
 const start=page.indexOf('function styleRatioReport('),end=page.indexOf('\n/* ratio-presentation:v1:end */',start);assert.ok(start>=0&&end>start);
 return new Function('document','ratioHoldingDisplayName','foldRatioFundNotes',page.slice(page.indexOf('function arrangeRatioRowDetails('),page.indexOf('function foldRatioFundNotes('))+page.slice(start,end)+'\nreturn styleRatioReport;')(f.document,s=>s,()=>{});
}
for(const mode of [{returns:true,inline:true},{returns:true,inline:true,reverse:true,extra:true},{returns:true,inline:false},{returns:false}])test('card styling preserves direct returns, disclosures and native values '+JSON.stringify(mode),()=>{
 const f=presentationFixture(mode),style=actualPresentation(f);style(f.root);
 const cards=f.exposure.querySelectorAll('.ratio-holding-row');assert.equal(cards.length,20);
 assert.equal(f.exposure.querySelectorAll('.ratio-returns').length,mode.returns?20:0);
 assert.equal(f.exposure.querySelectorAll('.ratio-return-period').length,mode.returns&&!mode.inline?40:0);
 assert.equal(f.exposure.querySelectorAll('.ratio-return-date-fact').length,mode.returns&&mode.inline?40:0);
 assert.equal(f.exposure.querySelectorAll('.ratio-return-compact-line').length,mode.returns&&mode.inline?40:0);
 assert.equal(f.overviewNotes.parentNode,f.overview);assert.equal(f.overviewNotes.classList.contains('kpi'),false,'the shared disclosure row must not be moved into legacy asset cards');
 for(const [i,card]of cards.entries()){
  const o=f.originals[i];assert.equal(card.querySelector('.ratio-holding-amount').textContent,o.amount);assert.equal(card.querySelector('.ratio-holding-accounts'),o.account);
  assert.deepEqual(card.querySelectorAll('dd').map(n=>n.textContent),o.weights.split('／'));
  for(const disclosure of o.disclosures)assert.ok(disclosure.closest('.ratio-holding-row')===card,'same nodes remain under the matching holding');
  if(o.rate){assert.equal(o.rate.classList.contains('ratio-composition'),false);if(mode.inline){
   assert.equal(o.rate.querySelector('.ratio-return-compact').parentNode,o.rate,'values stay outside the closed evidence panel');
   assert.equal(o.rate.querySelector('.ratio-return-inline-label').textContent,o.category===3?'直接持仓收益率':'收益率');
   const facts=card.querySelector('.ratio-return-facts');assert.equal(facts.querySelector('summary').textContent,'收益率说明');
   assert.equal(facts.parentNode.className,'ratio-row-disclosures');assert.equal(facts.querySelectorAll('p').length,3);
  }else assert.equal(o.rate.textContent,o.rateText);}
  if(o.composition){assert.equal(o.composition.classList.contains('ratio-composition'),true);assert.equal(o.composition.querySelector('summary').textContent,'持仓明细');assert.equal(o.composition.querySelectorAll('li').length,2);}

 }
 const before=f.root.textContent;style(f.root);assert.equal(f.root.textContent,before);assert.equal(f.exposure.querySelectorAll('.ratio-holding-row').length,20,'second styling is inert');
});

// Target-gap rendering regression fixtures (synthetic and isolated).
{
const assetNames=['PE/VC','对冲基金','常青基金','股票市场','现金类','主题投资'];
const stockNames=['美国底仓','美国科技','非美发达','新兴市场'];
const assetTargets=[0,15,35,40,8,2],stockTargets=[45,20,23,12];
const accounts=['Synthetic account'];
const view={valuationDate:'2026-11-06',portfolioTotalUsd:100,groups:['PE/VC','对冲基金','常青基金','二级市场'].map(category=>({category,totalUsd:25,top:[]})),residualUsd:0,residualPortfolioWeightPct:0,residualCategoryWeightPct:0,limitations:[],transferStatus:'Synthetic only'};
const core=createFeeRatioCore({buildRankedExposureView:()=>structuredClone(view)});
function model(assetValues=[1000,1500,2500,4000,800,200],stockValues=[5000,2000,2000,1000]){
 const totalCents=assetValues.reduce((a,b)=>a+b,0);
 return {report:{kind:'snapshot',targetDate:'2026-11-06',generatedAt:'2026-11-06T10:00:00.000Z',feeAccountingThrough:null},exposure:{summary:{accounts}},limitations:[],sourceDates:{classification:'2026-11-05',exposure:'2026-11-06'},classificationSummary:{asOf:'2026-11-05',totalValueUSD:totalCents/100,classes:['PE/VC','对冲基金','常青基金','二级市场'].map((name,i)=>({name,totalValueUSD:(i<3?assetValues[i]:assetValues.slice(3).reduce((a,b)=>a+b,0))/100})),gold:{valueUSD:0,secondaryIncluded:true},basis:'complete-official-classification-excluding-benchmark-only.v1',assetAllocation:{totalCents,groups:assetValues.map((valueCents,i)=>({name:assetNames[i],valueCents,targetPct:assetTargets[i],accounts:[]}))},fundDistributions:[{name:'常青基金',totalCents:assetValues[2],groups:[{name:'Synthetic strategy',valueCents:assetValues[2]}]},{name:'对冲基金',totalCents:assetValues[1],groups:[]}]},book:{asOf:'2026-11-05',allocation:{totalCents:stockValues.reduce((a,b)=>a+b,0),categories:stockValues.map((valueCents,i)=>({label:stockNames[i],valueCents,targetPct:stockTargets[i]})),cashLike:[]},ibCashCents:123456,noahCashCents:654321}};
}
function addPerformance(m){
 m.sourceDates.performance='2026-11-05';
 m.performance={schema:'fee-console.ratio-performance-source.v2',provider:'Sharesight',currency:'USD',asOf:'2026-11-05',accounts,reports:['all','oneYear'].map((period,i)=>({period,startDate:i?'2025-11-05':'2020-01-02',endDate:'2026-11-05',includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'excluded',source:{libraryFileId:'libfile_'+String(i+1).repeat(32),version:0,sha256:String(i+1).repeat(64),locator:'Synthetic total row'},rows:[{scope:{type:'portfolio',name:'All Together',parent:null},members:[{account:accounts[0],market:'SYNTHETIC',securityCode:'TEST'}],sourceSheet:'Synthetic total',sourceRow:2,returnPct:i?0:-1.25,returnAmountUSD:i?0:-12345.67,unit:'unknown',termEvidence:{type:'unknown'}}],unavailable:[]}))};return m;
}
function table(html,className){const start=html.indexOf('<table class="'+className+'">');assert.ok(start>=0);return html.slice(start,html.indexOf('</table>',start));}
function gaps(html){return [...html.matchAll(/aria-label="目标差额 USD ([+-]?[\d,]+\.\d{2})"/g)].map(m=>BigInt(m[1].replace(/[,.+]/g,'')));}
function total(html){return html.split('<div class="ratio-total-summary">')[1].split('<div class="ratio-overview-disclosures">')[0];}

test('six-class and IB-only targets use distinct existing bases, preserving models',()=>{
 const m=model(),before=structuredClone(m),html=core.render(m);
 assert.deepEqual(gaps(table(html,'ratio-overview-table')),[-1000n,0n,1000n,0n,0n,0n]);
 assert.deepEqual(gaps(table(html,'ratio-stock-table')),[-500n,0n,300n,200n]);
 assert.match(html,/基数：All Together 六类资产总额/);assert.match(html,/基数：仅 IB-HK 四类股票市值合计/);
 assert.deepEqual(m,before);assert.doesNotMatch(html,/-0\.00/);
});
test('cash balances do not become stock target budget, and strategy rows acquire no target',()=>{
 const m=model(),before=table(core.render(m),'ratio-stock-table');m.book.ibCashCents=999999999;m.book.noahCashCents=888888888;
 assert.equal(table(core.render(m),'ratio-stock-table'),before);
 const funds=core.render(m).split('<section class="card ratio-fund-distribution">').slice(1).map(x=>x.split('</section>')[0]);
 assert.ok(funds.length===2&&funds.every(x=>!x.includes('ratio-target-gap')));
});
test('BigInt allocations conserve every cent for tiny and maximum supported totals',()=>{
 for(const n of [1,2,3,6,7,11,17,99,101,999,99999999999999,100000000000000]){
  const vals=[n,0,0,0,0,0],m=model(vals,[n,0,0,0]),html=core.render(m);
  for(const [name,v]of [['ratio-overview-table',vals],['ratio-stock-table',[n,0,0,0]]]){
   const ds=gaps(table(html,name));assert.equal(ds.reduce((a,b)=>a+b,0n),0n,'deltas conserve '+n);
   const targets=ds.map((d,i)=>d+BigInt(v[i]));assert.equal(targets.reduce((a,b)=>a+b,0n),BigInt(n));assert.ok(targets.every(x=>x>=0n));
   if(name==='ratio-overview-table')assert.equal(targets[0],0n,'zero percent stays zero');
  }
 }
});
test('equal remainder assigns cents in fixed classification order and zero never gains a sign',()=>{
 const m=model([10,0,0,0,0,0]);
 assert.deepEqual(gaps(table(core.render(m),'ratio-overview-table')),[-10n,2n,3n,4n,1n,0n]);
 const exact=model([0,15,35,40,8,2],[45,20,23,12]),html=core.render(exact);
 assert.equal((html.match(/>\(0\.00\)<\/small>/g)||[]).length,10);assert.doesNotMatch(html,/\(-0\.00\)|\(\+0\.00\)/);
});
test('missing or invalid comparison basis yields a dash without weakening model validation',()=>{
 const m=model();m.classificationSummary.assetAllocation.totalCents++;
 assert.equal(gaps(table(core.render(m),'ratio-overview-table')).length,0);
 assert.equal((table(core.render(m),'ratio-overview-table').match(/>\(—\)<\/small>/g)||[]).length,6);
 const zero=model([0,0,0,0,0,0],[0,0,0,0]),html=core.render(zero);assert.doesNotMatch(html,/NaN|Infinity/);assert.equal(gaps(html).length,0);
 const negative=model();negative.classificationSummary.assetAllocation.groups[0].valueCents=-1;assert.throws(()=>core.render(negative),/RATIO_MANAGER_REFUSED/);
});
test('stock currency is in header and exact current values remain above target differences',()=>{
 const html=core.render(model()),stock=table(html,'ratio-stock-table');
 assert.match(stock,/<th>当前市值（USD）<\/th>/);
 assert.match(stock,/<span class="ratio-money-precise">50\.00<\/span><small class="ratio-target-gap"/);
 assert.doesNotMatch(stock,/>USD /);assert.match(html,/数据截至 2026-11-05/);
});
test('total assets have their own hierarchy and preserve official amounts and absence',()=>{
 const m=addPerformance(model()),before=structuredClone(m),html=core.render(m),t=total(html);
 assert.doesNotMatch(html,/<tfoot>/);assert.match(t,/<h3>总资产（USD）<\/h3>/);assert.match(t,/>100\.00<\/span>/);
 assert.match(t,/收益率 \/ 收益金额（USD）/);assert.match(t,/-1\.25%/);assert.match(t,/0\.00%/);assert.match(t,/-12,345\.67/);assert.match(t,/收益 0\.00/);
 assert.equal((html.match(/class="ratio-return-amount"/g)||[]).length,2);assert.deepEqual(m,before);
 delete m.performance.reports[0].rows[0].returnAmountUSD;assert.match(total(core.render(m)),/>收益 —<\/span>/);
});
test('fund metrics name current value and class weight and do not hide date or missing returns',()=>{
 const html=core.render(addPerformance(model())),fund=html.split('<section class="card ratio-fund-distribution">')[1];
 assert.match(fund,/<small>当前市值（USD）<\/small>/);assert.match(fund,/<small>占比<\/small>/);
 assert.match(fund,/<span class="ratio-distribution-amount"><span class="ratio-money-precise">25\.00<\/span>/);
 assert.match(fund,/截至 2026-11-05/);assert.match(fund,/收益率/);assert.match(fund,/>—<\/strong>/);
});
test('one common disclosure retains scope and unit semantics without being a trade instruction',()=>{
 const html=core.render(addPerformance(model()));
 assert.equal((html.match(/class="ratio-overview-return-notes"/g)||[]).length,1);
 assert.match(html,/含已平仓/);assert.match(html,/不平均百分比/);assert.match(html,/非年化金额/);assert.match(html,/无标记时未确认年化/);assert.match(html,/不代表0%/);
 assert.match(html,/不含 ETF 穿透敞口，也不乘杠杆倍数/);assert.match(html,/未计预算、资本承诺或交易限制/);assert.match(html,/PE\/VC目标0%不代表卖出指令/);
});
}

test('category disclosures move only exact matching existing holdings, keeping ambiguous history in place',()=>{
 const f=presentationFixture(),el=(tag,cls='',text='')=>{const n=new PresentationNode(tag);n.className=cls;n.textContent=text;return n;};
 const section=el('section','ratio-fund-distribution'),archive=el('details','ratio-distribution-details');archive.append(el('summary','','分类、账户与参考目标'));
 const rows=[],categories=[];
 for(const name of ['SYNTH A','SYNTH B','SYNTH B']){
  const row=el('div','ratio-distribution-row'),weight=el('span','ratio-distribution-weight');weight.append(el('strong','','25.00%'));row.append(el('span','ratio-distribution-name',name),weight);
  const compact=el('div','ratio-return-compact'),line=el('span','ratio-return-compact-line');line.append(el('span','','近一年：'),el('strong','','-12.34%'));compact.append(line);
  const facts=el('details','ratio-return-facts');facts.append(el('summary','','详情'),el('p','','2025-01-01 至 2026-01-01'));
  row.append(compact,facts);section.append(row);rows.push(row);
  const category=el('section','ratio-distribution-category');category.append(el('h3','',name+' · 25.00%'),el('li','',name+' holding'));archive.append(category);categories.push(category);
 }
 archive.append(el('p','','此历史快照未包含账户及持仓明细，更新快照后可查看。'));section.append(archive);f.report.append(section);
 actualPresentation(f)(f.root);
 assert.equal(categories[0].closest('.ratio-distribution-row'),rows[0]);
 for(const category of categories.slice(1))assert.equal(category.parentNode,archive);
 assert.equal(rows[0].querySelectorAll('summary').map(n=>n.textContent).join('|'),'收益率说明|持仓明细');
 assert.equal(rows[0].querySelector('.ratio-return-value').textContent,'近一年：-12.34%');
 assert.equal(categories[0].querySelector('li').textContent,'SYNTH A holding');
 assert.match(archive.textContent,/历史快照未包含/);assert.equal(f.report.querySelectorAll('.ratio-distribution-category').length,3);
});
