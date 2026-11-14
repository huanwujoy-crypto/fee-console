// Synthetic workbooks only. No credentials, financial reads or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {readVerifiedBrowserEvidence} from './fee-ratio-browser-evidence.mjs';
import {buildRatioModel} from './fee-ratio-packet.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function syntheticOfficialSource(){
 const accounts=['IB-HK','NOAH-HK',...Array.from({length:8},(_,i)=>'Synthetic '+i)],positions=[],cashAccounts=[],rows=[];
 let cr=10,er=5;
 const position=(account,securityCode,market,sharesightCategory,valueUSD,extra={})=>{const p={sourceRow:cr++,account,name:'Synthetic '+securityCode,valueUSD,sharesightCategory,securityCode,market,quantity:2,...extra};positions.push(p);return p;};
 const exposure=(p,ownership,valueUSD,extra={})=>rows.push({sourceRow:er++,account:p.account,securityCode:p.securityCode,market:p.market,name:p.name,withinETF:null,ownership,valueUSD,sourcePercentage:null,...extra});
 for(let i=0;i<3;i++)for(let j=0;j<5;j++){const p=position(accounts[i+2],'F'+i+j,'PRIVATE',['VC/PE','对冲基金','常青基金'][i],100-j);exposure(p,'Direct',110-j);}
 for(const [i,code,market]of [[0,'VST','NYSE'],[1,'GOOG','NASDAQ'],[2,'GOOGL','NASDAQ'],[3,'OTHER','TEST'],[4,'USSC','TEST']]){const p=position('IB-HK',code,market,['美国底仓','美国科技','非美发达','新兴市场','美国底仓'][i],30+i);exposure(p,'Direct',40+i);}
 const gold=position('IB-HK','GLD','NYSE','主题投资',9);exposure(gold,'Direct',10);
 const mining=position('IB-HK','GOLD','NYSE','主题投资',8);exposure(mining,'Direct',9);
 const etf=position('IB-HK','VSTL','NASDAQ','主题投资',20);
 exposure(etf,'Underlying',60,{securityCode:'VST',market:'NYSE',name:'Synthetic VST underlying',withinETF:'VSTL.NASDAQ'});
 exposure(etf,'Residual',-30);
 const other=position('IB-HK','INDEX','TEST','主题投资',10);
 exposure(other,'Underlying',8,{securityCode:'EXTRA',market:'TEST',name:'Synthetic extra underlying',withinETF:'INDEX.TEST'});exposure(other,'Residual',2);
 for(const account of ['IB-HK','NOAH-HK']){const c={sourceRow:cr++,account,name:'Synthetic USD cash',valueUSD:5,sharesightCategory:'Cash Accounts'};cashAccounts.push(c);rows.push({sourceRow:er++,account,securityCode:null,market:null,name:c.name,withinETF:null,ownership:'Cash',valueUSD:6,sourcePercentage:null});}
 const capture=(asOf,at,rows)=>({asOf,capturedAt:at,captureTimeBasis:'original-download-file-mtime',downloadCompletedAt:null,serverSuggestedOriginalFilename:null,dateEvidence:'Showing as at '+(asOf.endsWith('29')?'29':'30')+' Oct 2026',canonicalDataRows:rows,allWorksheetXmlRows:rows+5});
 return {schemaVersion:'sharesight-private-full-v2',source:{provider:'Sharesight',view:'All Together',transport:'official-workbook-exports'},accounts,sources:['classification.xlsx','exposure.xlsx','capture-metadata.json'].map((file,i)=>({file,sha256:String(i+1).repeat(64),libraryFileId:'libfile_'+String(i+1).repeat(32),libraryVersion:0})),classification:{...capture('2026-10-29','2026-10-30T05:31:53.561Z',positions.length+cashAccounts.length),positions,cashAccounts},exposure:{...capture('2026-10-30','2026-10-30T05:28:49.118Z',rows.length),rows},coverage:{classificationCombinedComplete:true,exposureCombinedComplete:true,groupingSheetsAreDuplicates:true,closedPositionsIncluded:false,transactionHistoryIncluded:false,completeETFUniverseClaimed:false},limitations:['Synthetic complete Combined sheet; other grouping sheets are duplicates.']};
}
function projected(raw=syntheticOfficialSource(),options={},clock=new Date('2026-10-30T06:00:00.000Z')){
 const bytes=Buffer.from(JSON.stringify(raw)),sha=hash(bytes),built=createOfficialRatioSourceCore().build(raw,{sourceSha256:sha,sourceBytes:bytes.length,...options}),scope=hash(JSON.stringify([...raw.accounts].sort())),exposure={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scope},ratio=createFeeRatioCore(exposure,crypto.webcrypto),source=createRatioSourceCore(()=>scope),now=clock;
 return {raw,bytes,sha,built,scope,exposure,ratio,source,now};
}
test('mixed official dates keep their own totals, signed residual and same-export parent basis',()=>{
 const f=projected(),{input,companyContext}=f.built;
 assert.equal(input.classification.asOf,'2026-10-29');assert.equal(input.exposure.summary.asOf,'2026-10-30');
 assert.notEqual(input.classification.totalValueUSD,input.exposure.summary.totalValueUSD);
 assert.equal(input.classification.gold.valueUSD,9);assert.equal(input.classification.gold.rule,'physical-gold-etf.GLD.NYSE.v1');
 assert.equal(companyContext.positions.find(p=>p.securityCode==='VSTL').valueUSD,30);
 assert.equal(companyContext.positions.find(p=>p.securityCode==='VSTL').quantity,null);
 const view=f.exposure.buildRankedExposureView(input.exposure);assert.equal(view.valuationDate,'2026-10-30');
 const facts=f.source.verifyBrowserSourceAssociations(f.raw,input,{scopeHash:f.scope,now:f.now});
 assert.deepEqual(facts.sourceDates,{classification:'2026-10-29',exposure:'2026-10-30'});
 const companies=createFeeCompanyExposureCore().validate(facts.companyExposure,input.exposure,input.book.sourceSha256);
 assert.equal(companies.state,'projection-complete');
 assert.equal(companies.top.find(r=>r.companyId==='vistra').valueUsd,100);
 assert.equal(companies.top.find(r=>r.companyId==='alphabet').valueUsd,83);
 assert.equal(facts.observedAt,'2026-10-30T05:28:49.118Z');
});
test('source-date explanation advances with both verified source dates',()=>{
 const raw=syntheticOfficialSource();
 for(const [role,day] of [['classification','30'],['exposure','31']]){
  raw[role].asOf='2026-10-'+day;
  raw[role].capturedAt='2026-10-31T05:30:00.000Z';
  raw[role].dateEvidence='Showing as at '+day+' Oct 2026';
 }
 const input=projected(raw).built.input,explanation=input.exposure.summary.limitations.at(-1);
 assert.equal(explanation,'2026-10-31 Exposure分组沿用 2026-10-30 资产类别标签；金额和比例分母取 2026-10-31 完整Exposure原表。');
 assert.doesNotMatch(explanation,/29日|30日Exposure/);
 assert.equal(input.classification.asOf,'2026-10-30');assert.equal(input.exposure.summary.asOf,'2026-10-31');
});
test('missing, duplicated, malformed or misassociated original rows fail without inventing replacement values',()=>{
 const edits=[r=>r.classification.positions.pop(),r=>r.exposure.rows.pop(),r=>r.exposure.rows[1].sourceRow=r.exposure.rows[0].sourceRow,r=>r.classification.positions.push({...r.classification.positions[0],sourceRow:999}),r=>r.exposure.rows[0].account='Unknown',r=>r.exposure.rows.find(x=>x.ownership==='Underlying').withinETF='WRONG.TEST',r=>r.exposure.rows.find(x=>x.ownership==='Cash').name='Unknown',r=>r.classification.positions[0].valueUSD=0.004,r=>r.exposure.rows[0].valueUSD=NaN,r=>r.classification.asOf='2026-10-30',r=>r.exposure.asOf='2026-10-29',r=>r.coverage.exposureCombinedComplete=false,r=>r.classification.downloadCompletedAt='invented',r=>r.sources[0].sha256='x',r=>r.classification.extra=true];
 for(const edit of edits){const raw=syntheticOfficialSource();edit(raw);assert.throws(()=>projected(raw));}
});
test('original association recomputes both date-specific projections and capture freshness',()=>{
 const f=projected();
 for(const mutate of [i=>i.classification.totalValueUSD++,i=>i.exposure.summary.classes[0].totalValueUSD++,i=>i.book.asOf='2026-10-30',i=>i.book.provenance.classificationCapturedAt=i.book.provenance.exposureCapturedAt,i=>i.exposure.summary.asOf='2026-10-29']){const input=structuredClone(f.built.input);mutate(input);assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,input,{scopeHash:f.scope,now:f.now}));}
 assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:'0'.repeat(64),now:f.now}));
 for(const at of ['2026-10-30T05:30:00.000Z','2026-11-01T00:00:00.000Z'])assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:f.scope,now:new Date(at)}));
});
test('same-name fund securities stay separate and a claimed capture before its valuation date is rejected',()=>{
 const raw=syntheticOfficialSource();raw.classification.positions[1].name=raw.classification.positions[0].name;
 const input=projected(raw).built.input,top=input.exposure.summary.classes[0].top5;
 assert.equal(new Set(top.map(r=>r.name)).size,5);assert.ok(top[0].name.includes('[F00 · PRIVATE]'));assert.ok(top[1].name.includes('[F01 · PRIVATE]'));
 raw.classification.capturedAt='2026-10-27T00:00:00.000Z';assert.throws(()=>projected(raw));
});
export async function authenticated(t,raw=syntheticOfficialSource(),options={},{now=new Date('2026-10-30T06:00:00.000Z'),targetDate='2026-10-30'}={}){
 const f=projected(raw,options,now),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ratio-official-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),p=path.join(dir,name);fs.writeFileSync(p,bytes,{mode:0o600});return {path:p,sha256:hash(bytes)};};
 const manager=await f.ratio.deriveSnapshotManager('0'.repeat(32),Buffer.alloc(32,7).toString('base64url'),'synthetic-manager-token-not-real-123'),plan={schema:'fee-console.ratio-browser-evidence-plan.v1',workspace:dir,source:write('original.json',f.bytes),input:write('input.json',f.built.input),library:{libraryFileId:'libfile_'+'9'.repeat(32),version:0},managerScopeId:manager.recipient.scopeId,localOwnerUid:process.getuid()},planPath=write('plan.json',plan).path;
 const proof=readVerifiedBrowserEvidence({planPath,expectedScopeId:manager.recipient.scopeId,input:f.built.input,now:f.now,runtime:{uid:process.getuid(),readIdentity:()=>({libraryFileId:plan.library.libraryFileId,version:0})},exposureCore:f.exposure});
 const model=await buildRatioModel(f.built.input,{kind:'snapshot',targetDate,browserEvidence:proof,managerScopeId:manager.recipient.scopeId,viewCore:f.ratio,now:f.now});
 const snapshot=createRatioSnapshotCore(f.ratio,f.exposure,createRatioSourceCore,b=>JSON.parse(Buffer.from(b)),crypto.webcrypto),args={originalBytes:new Uint8Array(f.bytes),inputBytes:new Uint8Array(fs.readFileSync(plan.input.path)),model,recipient:manager.recipient,sourceSha256:f.sha,inputSha256:plan.input.sha256,libraryVersion:0,now:f.now},original=await snapshot.verifyOriginal(args),packet=await snapshot.candidate({model,recipient:manager.recipient,proof:original,now:f.now}),signed=await snapshot.authenticate(packet,original,manager,{profileSha256:'a'.repeat(64),now:f.now});
 return {...f,model,manager,snapshot,args,signed};
}
test('full source to manager snapshot authenticates both dates, renders distinct denominators and keeps fee data outside',async t=>{
 const f=await authenticated(t),result=await f.snapshot.verify(f.signed,f.manager,{now:f.now});
 assert.deepEqual(result.source.sourceDates,f.model.sourceDates);assert.equal(result.stale,false);
 const html=f.ratio.render(result.model);
 for(const text of ['资产分类截至 2026-10-29','个股穿透截至 2026-10-30','Exposure截至 2026-10-30','黄金（GLD）','已计入所属分类，不另加总','独立下载完成时间未知','二级市场 · 直接持仓前五','不做ETF穿透、不乘杠杆倍数','计算口径与合并规则'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/公司经济敞口|原证券口径前五|持仓与穿透明细/);
 assert.doesNotMatch(html,/完整持仓|undefined|<details open/);
 assert.equal((html.match(/<details><summary>/g)||[]).length>=4,true);
 assert.equal(result.model.feeCalculationReceipt,undefined);
 const late=await f.snapshot.verify(f.signed,f.manager,{now:new Date('2026-11-02T00:00:00.000Z')});assert.equal(late.stale,true);
});

test('secondary top five ranks actually held securities at asset value without look-through, leverage or aliases',async t=>{
 const f=projected(),secondary=f.built.input.exposure.summary.classes[3];
 assert.equal(secondary.basis,'direct');
 assert.deepEqual(secondary.top5.map(r=>[r.securityCode,r.valueUSD]),[['USSC',44],['OTHER',43],['GOOGL',42],['GOOG',41],['VST',40]]);
 for(const r of secondary.top5)assert.deepEqual(r.accounts,['IB-HK']);
 // A leveraged product ranks as itself at its own asset value: the 60 of
 // underlying exposure and the 2x rule never enter the ranking.
 const leveraged=syntheticOfficialSource(),row=leveraged.exposure.rows.find(r=>r.ownership==='Underlying'&&r.withinETF==='VSTL.NASDAQ');row.valueUSD=160;
 const top=projected(leveraged).built.input.exposure.summary.classes[3].top5;
 assert.deepEqual(top.map(r=>[r.securityCode,r.valueUSD]),[['VSTL',130],['USSC',44],['OTHER',43],['GOOGL',42],['GOOG',41]]);
 assert.equal(top.some(r=>r.name.includes('underlying')),false);
 // The same security in two accounts merges and keeps both accounts.
 const merged=syntheticOfficialSource(),p=merged.classification.positions.find(x=>x.securityCode==='GOOG'),e=merged.exposure.rows.find(x=>x.securityCode==='GOOG'&&x.ownership==='Direct');
 merged.classification.positions.push({...p,sourceRow:910,account:merged.accounts[4],valueUSD:5});merged.exposure.rows.push({...e,sourceRow:910,account:merged.accounts[4],valueUSD:6});
 merged.classification.canonicalDataRows++;merged.classification.allWorksheetXmlRows++;merged.exposure.canonicalDataRows++;merged.exposure.allWorksheetXmlRows++;
 const first=projected(merged).built.input.exposure.summary.classes[3].top5[0];
 assert.deepEqual([first.securityCode,first.valueUSD,first.accounts],['GOOG',47,['IB-HK',merged.accounts[4]]]);
 const view=f.exposure.buildRankedExposureView(f.built.input.exposure);
 assert.equal(view.groups[3].directOnly,true);assert.equal(view.groups.slice(0,3).some(g=>Object.hasOwn(g,'directOnly')),false);
 // A direct ranking must fit inside its own class; the older look-through
 // basis stays readable, and neither basis can be relabelled as the other.
 const over=structuredClone(f.built.input.exposure);over.summary.classes[3].top5[0].valueUSD=over.summary.classes[3].totalValueUSD+1;
 assert.throws(()=>f.exposure.buildRankedExposureView(over),/RANKED_TOTAL/);
 const legacy=structuredClone(f.built.input.exposure);legacy.summary.classes[3].basis='Exposure individual security direct plus ETF look-through, includes cash in class denominator';
 assert.equal(Object.hasOwn(f.exposure.buildRankedExposureView(legacy).groups[3],'directOnly'),false);
 const v1=structuredClone(f.built.input.exposure);v1.schema='xuan.sharesight-exposure-ranked.v1';assert.throws(()=>f.exposure.buildRankedExposureView(v1));
 for(const basis of ['Direct','direct ',''])assert.throws(()=>{const bad=structuredClone(f.built.input.exposure);bad.summary.classes[3].basis=basis;f.exposure.buildRankedExposureView(bad);},/RANKED_CLASSES/);
 const targets=createAggregateReturnsCore().topTargets(f.built.input.exposure,[{name:'Invented company',constituents:[]}]);
 assert.equal(targets.length,20);assert.deepEqual(targets.slice(15).map(r=>[r.category,r.name,r.basis,r.members]),secondary.top5.map(r=>['二级市场',r.name,'direct-holdings-only',[{account:'IB-HK',market:r.market,securityCode:r.securityCode}]]));
 assert.equal(createAggregateReturnsCore().topTargets(legacy,[{name:'Invented company',constituents:[]}]).at(-1).name,'Invented company');
 const a=await authenticated(t),html=a.ratio.render(a.model),section=html.split('二级市场 · 直接持仓前五')[1].split('</section>')[0];
 assert.deepEqual([...section.matchAll(/data-security-code="([^"]*)"/g)].map(m=>m[1]),['USSC','OTHER','GOOGL','GOOG','VST']);
 assert.doesNotMatch(html,/Vistra|Alphabet|经济敞口 USD/);
});
test('an input prepared under the earlier look-through secondary basis still associates exactly; neither basis passes as the other',()=>{
 const core=createOfficialRatioSourceCore(),direct=projected(),legacy=projected(undefined,{directSecondary:false});
 const old=legacy.built.input.exposure.summary.classes[3];
 assert.equal(old.basis,core.LOOK_THROUGH_SECONDARY_BASIS);
 // The earlier basis adds the leveraged ETF's look-through row (60) to the direct holding (40).
 assert.deepEqual(old.top5[0],{name:'Synthetic VST',securityCode:'VST',market:'NYSE',accounts:['IB-HK'],valueUSD:100});
 assert.equal(direct.built.input.exposure.summary.classes[3].basis,'direct');
 // Everything outside the secondary ranking is identical under both.
 const strip=i=>{const c=structuredClone(i);delete c.exposure.summary.classes[3].basis;delete c.exposure.summary.classes[3].top5;return core.canonical(c);};
 assert.equal(strip(legacy.built.input),strip(direct.built.input));
 // The association follows the basis the input itself declares.
 for(const f of [direct,legacy])f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:f.scope,now:f.now});
 for(const [from,to] of [[direct,legacy],[legacy,direct]]){
  const relabelled=structuredClone(from.built.input);relabelled.exposure.summary.classes[3].basis=to.built.input.exposure.summary.classes[3].basis;
  assert.throws(()=>from.source.verifyBrowserSourceAssociations(from.raw,relabelled,{scopeHash:from.scope,now:from.now}),/RATIO_BROWSER_EVIDENCE_REFUSED/);
 }
 assert.throws(()=>projected(undefined,{directSecondary:'yes'}));
 assert.equal(legacy.exposure.buildRankedExposureView(legacy.built.input.exposure).groups[3].directOnly,undefined);
});
function benchmarkOnlyFixture(){
 const raw=syntheticOfficialSource(),account='Citi-HK & 地产四期';raw.accounts[9]=account;
 const add=(account,code,market,valueUSD,sourceRow,legs)=>{
  const p={sourceRow,account,name:'Synthetic reference '+code,securityCode:code,market,sharesightCategory:'美国底仓',valueUSD,quantity:1};raw.classification.positions.push(p);
  for(const [i,leg] of legs.entries())raw.exposure.rows.push({sourceRow:sourceRow+i,account,securityCode:code,market,name:p.name,withinETF:null,ownership:'Direct',valueUSD,sourcePercentage:null,...leg});
 };
 add(account,'QQQ','NASDAQ',1000,900,[{valueUSD:1100}]);
 add(account,'SPY','NYSE',2000,910,[{securityCode:'GOOG',market:'NASDAQ',ownership:'Underlying',withinETF:'SPY.NYSE',valueUSD:1700},{ownership:'Residual',valueUSD:500}]);
 add('IB-HK','QQQ','NASDAQ',10,920,[{valueUSD:11}]);
 add('IB-HK','SPY','NYSE',20,930,[{securityCode:'GOOG',market:'NASDAQ',ownership:'Underlying',withinETF:'SPY.NYSE',valueUSD:17},{ownership:'Residual',valueUSD:5}]);
 add(account,'QQQ','TEST',30,940,[{valueUSD:33}]);
 add(account,'OTHER','TEST',40,950,[{valueUSD:44}]);
 raw.classification.canonicalDataRows=raw.classification.positions.length+raw.classification.cashAccounts.length;raw.classification.allWorksheetXmlRows=raw.classification.canonicalDataRows+5;
 raw.exposure.canonicalDataRows=raw.exposure.rows.length;raw.exposure.allWorksheetXmlRows=raw.exposure.rows.length+5;
 return raw;
}
test('benchmark-only assets leave both date-specific denominators and rankings, never the original source or other accounts',()=>{
 const raw=benchmarkOnlyFixture(),before=JSON.stringify(raw),f=projected(raw),core=createOfficialRatioSourceCore(),legacy=core.build(raw,{sourceSha256:f.sha,sourceBytes:f.bytes.length,excludeBenchmarkOnly:false}),current=f.built;
 assert.equal(current.input.classification.basis,core.BENCHMARK_EXCLUDED_BASIS);
 assert.equal(legacy.input.classification.totalValueUSD-current.input.classification.totalValueUSD,3000);
 assert.equal(legacy.input.exposure.summary.totalValueUSD-current.input.exposure.summary.totalValueUSD,3300);
 assert.equal(legacy.input.classification.assetAllocation.groups[3].valueCents-current.input.classification.assetAllocation.groups[3].valueCents,300000);
 assert.equal(legacy.input.exposure.summary.classes[3].totalValueUSD-current.input.exposure.summary.classes[3].totalValueUSD,3300);
 assert.equal(legacy.input.exposure.summary.residualETFs.valueUSD-current.input.exposure.summary.residualETFs.valueUSD,500);
 const a=current.input.classification.assetAllocation;assert.equal(a.groups.reduce((n,g)=>n+g.valueCents,0),a.totalCents);for(const g of a.groups)assert.equal(g.accounts.reduce((n,r)=>n+r.valueCents,0),g.valueCents);
 assert.ok(current.companyContext.positions.some(p=>p.account==='IB-HK'&&p.securityCode==='QQQ'));
 assert.ok(current.companyContext.positions.some(p=>p.account==='IB-HK'&&p.securityCode==='SPY'));
 assert.ok(current.companyContext.positions.some(p=>p.account==='Citi-HK & 地产四期'&&p.securityCode==='QQQ'&&p.market==='TEST'));
 assert.ok(current.companyContext.positions.some(p=>p.account==='Citi-HK & 地产四期'&&p.securityCode==='OTHER'));
 assert.ok(current.companyContext.rows.some(r=>r.account==='IB-HK'&&r.withinETF==='SPY.NYSE'));
 assert.ok(current.companyContext.rows.every(r=>r.account!=='Citi-HK & 地产四期'||r.securityCode+'.'+r.market!=='QQQ.NASDAQ'&&r.securityCode+'.'+r.market!=='SPY.NYSE'&&r.withinETF!=='SPY.NYSE'));
 assert.deepEqual(current.input.book,legacy.input.book);assert.equal(JSON.stringify(raw),before);
 const facts=f.source.verifyBrowserSourceAssociations(raw,current.input,{scopeHash:f.scope,now:f.now}),company=createFeeCompanyExposureCore().validate(facts.companyExposure,current.input.exposure,current.input.book.sourceSha256);
 assert.equal(facts.companyExposure.portfolioTotalUsd,current.input.exposure.summary.totalValueUSD);assert.equal(facts.companyExposure.categoryTotalUsd,current.input.exposure.summary.classes[3].totalValueUSD);
 assert.equal(company.top.find(r=>r.companyId==='alphabet').valueUsd,100);
 assert.ok(current.input.exposure.summary.classes[3].top5.every(r=>r.valueUSD<1100));
 assert.doesNotThrow(()=>f.source.verifyBrowserSourceAssociations(raw,legacy.input,{scopeHash:f.scope,now:f.now}));
 for(const edit of [i=>i.classification.basis=legacy.input.classification.basis,i=>i.classification.totalValueUSD++,i=>i.exposure.summary.totalValueUSD++,i=>i.exposure.summary.classes[3].top5[0].valueUSD++]){const bad=structuredClone(current.input);edit(bad);assert.throws(()=>f.source.verifyBrowserSourceAssociations(raw,bad,{scopeHash:f.scope,now:f.now}));}
});
test('excluded benchmark rows still require complete source associations; matching remains account and venue exact',()=>{
 for(const mutate of [r=>r.exposure.rows.find(r=>r.sourceRow===911).valueUSD=NaN,r=>r.exposure.rows.splice(r.exposure.rows.findIndex(r=>r.sourceRow===911),1),r=>r.exposure.rows.find(r=>r.sourceRow===910).withinETF='UNKNOWN.NYSE']){const raw=benchmarkOnlyFixture();mutate(raw);assert.throws(()=>projected(raw));}
 const raw=benchmarkOnlyFixture();raw.accounts[9]='Citi-HK &amp; 地产四期';for(const r of raw.classification.positions.concat(raw.exposure.rows))if(r.account==='Citi-HK & 地产四期')r.account=raw.accounts[9];
 assert.equal(projected(raw).built.input.classification.totalValueUSD,projected(benchmarkOnlyFixture()).built.input.classification.totalValueUSD);
});
test('new exclusion snapshot authenticates and renders while prior signed six-category snapshots remain readable',async t=>{
 const f=await authenticated(t,benchmarkOnlyFixture()),read=await f.snapshot.verify(f.signed,f.manager,{now:f.now});
 assert.match(f.ratio.render(read.model),/已从投资资产、占比分母及穿透中排除/);
 const prior=await authenticated(t,benchmarkOnlyFixture(),{excludeBenchmarkOnly:false}),legacy=await prior.snapshot.verify(prior.signed,prior.manager,{now:prior.now});
 assert.equal(legacy.model.classificationSummary.basis,'complete-official-classification-row-sum');
 assert.doesNotMatch(prior.ratio.render(legacy.model),/已从投资资产、占比分母及穿透中排除/);
});
test('edited dates, summaries, downgrade, stale source, MAC and rollback cannot authenticate as a new formal snapshot',async t=>{
 const f=await authenticated(t);
 for(const change of [m=>m.sourceDates.classification='2026-10-30',m=>m.classificationSummary.totalValueUSD++,m=>m.classificationSummary.gold.valueUSD++,m=>m.schema='fee-console.ratio-view.v1',m=>delete m.sourceDates,m=>m.book.asOf='2026-10-30',m=>m.companyExposure.components[0].valueUsd++]){const model=structuredClone(f.model);change(model);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));}
 for(const change of [p=>p.body.source.sourceDates.classification='2026-10-30',p=>delete p.body.source.sourceDates,p=>p.body.source.kind='complete-original-browser-association',p=>p.authentication.mac='x']){const p=structuredClone(f.signed);change(p);await assert.rejects(f.snapshot.verify(p,f.manager,{now:f.now}));}
 const good=await f.snapshot.verify(f.signed,f.manager,{now:f.now});await assert.rejects(f.snapshot.verify(f.signed,f.manager,{now:f.now,watermark:{...good.watermark,version:2}}));
 await assert.rejects(f.snapshot.verify(f.signed,f.manager,{now:f.now,watermark:{...good.watermark,sourceDates:{classification:'2026-10-30',exposure:'2026-10-30'}}}));
});

test('ranked source preserves original security names and every contributing account without changing order or values',()=>{
 const raw=syntheticOfficialSource(),p=raw.classification.positions[0],r=raw.exposure.rows[0];
 p.name=r.name='Legacy Fund Series IV';p.securityCode=r.securityCode='2021-10-Synthetic Project-IV';
 raw.classification.positions.push({...p,sourceRow:900,account:raw.accounts[3],valueUSD:2});
 raw.exposure.rows.push({...r,sourceRow:900,account:raw.accounts[3],valueUSD:3});
 raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;raw.exposure.canonicalDataRows++;raw.exposure.allWorksheetXmlRows++;
 const f=projected(raw),first=f.built.input.exposure.summary.classes[0].top5[0];
 assert.equal(first.name,'Legacy Fund Series IV');assert.equal(first.securityCode,'2021-10-Synthetic Project-IV');
 assert.deepEqual(first.accounts,[raw.accounts[2],raw.accounts[3]]);assert.equal(first.valueUSD,113);
 const v=f.exposure.buildRankedExposureView(f.built.input.exposure);assert.deepEqual(v.groups[0].top[0].accounts,first.accounts);
 v.groups[0].top[0].accounts.pop();assert.equal(first.accounts.length,2);
 for(const mutate of [i=>i.exposure.summary.classes[0].top5[0].accounts=['Invented stranger'],i=>i.exposure.summary.classes[0].top5[0].accounts=[raw.accounts[2]],i=>i.exposure.summary.classes[0].top5[0].securityCode='2021-10-Other']){
  const input=structuredClone(f.built.input);mutate(input);assert.throws(()=>f.source.verifyBrowserSourceAssociations(raw,input,{scopeHash:f.scope,now:f.now}));
 }
});
test('company aggregation keeps all account labels and old authenticated models remain readable',async t=>{
 const f=await authenticated(t),company=createFeeCompanyExposureCore(),model=f.model,view=company.validate(model.companyExposure,model.exposure,model.book.sourceSha256);
 assert.ok(view.top.every(r=>r.accounts.length>0));assert.equal(view.top.find(r=>r.companyId==='vistra').valueUsd,100);assert.equal(view.top.find(r=>r.companyId==='alphabet').valueUsd,83);
 for(const mutate of [m=>m.companyExposure.components[0].account='Unknown account',m=>m.companyExposure.components[0].account=f.raw.accounts[3]]){
  const bad=structuredClone(model);mutate(bad);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:bad}));
 }
 const legacy=structuredClone(model);for(const c of legacy.companyExposure.components)delete c.account;
 for(const [i,g] of legacy.exposure.summary.classes.entries())for(const r of g.top5){delete r.accounts;delete r.sourceHoldings;if(i<3){delete r.securityCode;delete r.market;}}
 await f.ratio.validateModel(legacy);const sealed=await f.ratio.seal(legacy,f.manager.recipient);assert.deepEqual(await f.ratio.open(sealed,f.manager),legacy);
 const prior=company.validate(legacy.companyExposure,legacy.exposure,legacy.book.sourceSha256);
 assert.deepEqual(prior.top.map(r=>[r.companyId,r.valueUsd,r.portfolioWeightPct,r.categoryWeightPct]),view.top.map(r=>[r.companyId,r.valueUsd,r.portfolioWeightPct,r.categoryWeightPct]));
 const html=f.ratio.render(model);assert.ok(html.indexOf('ratio-stock-allocation')<html.indexOf('sharesight-exposure'));assert.equal(html.match(/股票四类配置/g).length,1);
 assert.ok(html.includes('class="ratio-holding-accounts"'));assert.doesNotMatch(html,/<details[^>]* open/);
});

// Synthetic dated products: aggregate complete input, never just an old top five.
function evergreenFixture(){
 const raw=syntheticOfficialSource(),ps=raw.classification.positions.filter(p=>p.sharesightCategory==='常青基金');
 const names=['2020-01-Synthetic Alpha E-1','2021-02-Synthetic Alpha E-1','2022-03-Synthetic Beta','2023-04-Synthetic Gamma','2024-05-Synthetic Delta'];
 for(let i=0;i<ps.length;i++){const p=ps[i],code=p.securityCode;p.securityCode=names[i];p.name='Synthetic channel '+i;const r=raw.exposure.rows.find(r=>r.securityCode===code);r.securityCode=p.securityCode;r.name=p.name;}
 const p={...ps[0],sourceRow:999,account:raw.accounts[5],securityCode:'2025-06-Synthetic Epsilon',name:'Synthetic later holding',valueUSD:50};raw.classification.positions.push(p);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;
 raw.exposure.rows.push({sourceRow:999,account:p.account,securityCode:p.securityCode,market:p.market,name:p.name,withinETF:null,ownership:'Direct',valueUSD:50,sourcePercentage:null});raw.exposure.canonicalDataRows++;raw.exposure.allWorksheetXmlRows++;return raw;
}
test('evergreen merges exact original month suffix before ranking, retains share class and all accounts',()=>{
 const raw=evergreenFixture(),before=JSON.stringify(raw),f=projected(raw),g=f.built.input.exposure.summary.classes[2],top=g.top5;
 assert.equal(top.length,5);assert.equal(top[0].name,'Synthetic Alpha E-1');assert.equal(top[0].valueUSD,219);assert.equal(top[0].sourceHoldings.length,2);assert.ok(top.some(r=>r.name==='Synthetic Epsilon'));
 assert.equal(top.reduce((s,r)=>s+Math.round(r.valueUSD*100),0),Math.round(g.totalValueUSD*100));assert.equal(JSON.stringify(raw),before);
 const first=raw.classification.positions.find(p=>p.securityCode==='2021-02-Synthetic Alpha E-1'),r=raw.exposure.rows.find(r=>r.securityCode===first.securityCode);first.account=raw.accounts[6];r.account=first.account;
 const grouped=projected(raw).built.input.exposure.summary.classes[2].top5[0];assert.deepEqual(grouped.accounts,[raw.accounts[4],raw.accounts[6]].sort());assert.equal(grouped.sourceHoldings.length,2);
 first.securityCode='2021-02-Synthetic Alpha E-2';r.securityCode=first.securityCode;const distinct=projected(raw).built.input.exposure.summary.classes[2].top5;assert.ok(distinct.some(r=>r.name==='Synthetic Alpha E-1'));assert.ok(distinct.some(r=>r.name==='Synthetic Alpha E-2'));
});
test('evergreen never fuzzy-merges spelling, trailing class or later date text, and validates retained sources',()=>{
 for(const suffix of ['Synthetic alpha E-1','Synthetic Alpha E-1 (Accumulating)','Synthetic Alpha E-1 2025-06-Other']){
  const raw=evergreenFixture(),p=raw.classification.positions.find(p=>p.securityCode==='2021-02-Synthetic Alpha E-1'),r=raw.exposure.rows.find(r=>r.securityCode===p.securityCode);p.securityCode='2021-02-'+suffix;r.securityCode=p.securityCode;const top=projected(raw).built.input.exposure.summary.classes[2].top5;assert.ok(top.some(r=>r.name===suffix));assert.ok(top.every(r=>r.sourceHoldings.length===1));
 }
 const f=projected(evergreenFixture()),ranked=f.built.input.exposure;
 for(const edit of [r=>r.sourceHoldings[0].valueUSD++,r=>r.sourceHoldings[0].account='Unknown',r=>r.sourceHoldings.push({...r.sourceHoldings[0]}),r=>r.accounts=[],r=>r.sourceHoldings[0].extra=true]){const bad=structuredClone(ranked);edit(bad.summary.classes[2].top5[0]);assert.throws(()=>f.exposure.buildRankedExposureView(bad));}
 assert.equal(f.built.input.classification.gold.secondaryIncluded,true);assert.equal(f.built.input.book.ib.totalValueUSD,projected().built.input.book.ib.totalValueUSD);
});

test('fund distributions classify original first fields before same-name merging, using own classification totals',()=>{
 const raw=syntheticOfficialSource(),funds=raw.classification.positions.filter(p=>p.sharesightCategory==='常青基金');
 const labels=['策略甲-渠道-2021-10-Shared I','策略乙-渠道-2022-10-Shared I','策略甲-2023-01-Other-I','2024-01-Unknown','Undated'];
 funds.forEach((p,i)=>{const old=p.securityCode;p.securityCode=labels[i];for(const r of raw.exposure.rows)if(r.account===p.account&&r.securityCode===old)r.securityCode=p.securityCode;});
 const extra={...funds[4],sourceRow:901,securityCode:'Another undated',valueUSD:0};raw.classification.positions.push(extra);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;raw.exposure.rows.push({...raw.exposure.rows.find(r=>r.securityCode===funds[4].securityCode),sourceRow:901,securityCode:extra.securityCode,valueUSD:0});raw.exposure.canonicalDataRows++;raw.exposure.allWorksheetXmlRows++;
 const f=projected(raw),d=f.built.input.classification.fundDistributions.find(g=>g.name==='常青基金');
 assert.equal(d.totalCents,49000);assert.deepEqual(d.groups.map(({name,valueCents})=>({name,valueCents})),[{name:'策略甲',valueCents:19800},{name:'未分类',valueCents:19300},{name:'策略乙',valueCents:9900}]);
 assert.equal(d.groups.reduce((s,g)=>s+g.valueCents,0),d.totalCents);
 assert.notEqual(d.totalCents,Math.round(f.built.input.exposure.summary.classes[2].totalValueUSD*100));
 assert.equal(f.built.input.exposure.summary.classes[2].top5.find(g=>g.name==='Shared I').sourceHoldings.length,2);
 const facts=f.source.verifyBrowserSourceAssociations(raw,f.built.input,{scopeHash:f.scope,now:f.now});assert.deepEqual(facts.classificationSummary.fundDistributions,f.built.input.classification.fundDistributions);
 const tampered=structuredClone(f.built.input);tampered.classification.fundDistributions[0].groups[0].name='Guessed';assert.throws(()=>f.source.verifyBrowserSourceAssociations(raw,tampered,{scopeHash:f.scope,now:f.now}));
});
test('old official projections without distributions preserve exact original association',()=>{
 const f=projected(),old=createOfficialRatioSourceCore().build(f.raw,{sourceSha256:f.sha,sourceBytes:f.bytes.length,includeFundDistributions:false});
 assert.equal(Object.hasOwn(old.input.classification,'fundDistributions'),false);
 assert.doesNotThrow(()=>f.source.verifyBrowserSourceAssociations(f.raw,old.input,{scopeHash:f.scope,now:f.now}));
 const next=structuredClone(f.built.input);delete next.classification.fundDistributions;assert.deepEqual(next,old.input);
});
function fundDetailFixture(){
 const raw=syntheticOfficialSource();
 for(const category of ['常青基金','对冲基金']){
  const rows=raw.classification.positions.filter(p=>p.sharesightCategory===category);
  const extra={...rows[0],sourceRow:900+(category==='常青基金'?0:1),securityCode:'EXTRA-'+category,valueUSD:90};
  raw.classification.positions.push(extra);rows.push(extra);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;
  raw.exposure.rows.push({sourceRow:extra.sourceRow,account:extra.account,securityCode:extra.securityCode,market:extra.market,name:extra.name,withinETF:null,ownership:'Direct',valueUSD:95,sourcePercentage:null});raw.exposure.canonicalDataRows++;raw.exposure.allWorksheetXmlRows++;
  for(const [i,p]of rows.entries()){
   const code=p.securityCode,account=p.account,linked=raw.exposure.rows.find(r=>r.securityCode===code&&r.account===account);
   p.securityCode=['策略甲-渠道-2021-10-Synthetic Shared E-1','策略乙-2022-02-Synthetic Shared E-1','策略甲-2023-03-Synthetic Other-IV','策略甲-2024-04-Synthetic Long-Name E-2','策略乙-2025-05-Synthetic Final','策略乙-2026-06-Synthetic Sixth'][i];
   p.name='Synthetic platform alias '+i;if(i===2)p.account=raw.accounts[category==='常青基金'?6:7];
   linked.securityCode=p.securityCode;linked.name=p.name;linked.account=p.account;
  }
 }
 return raw;
}
test('fund detail rows preserve every source holding/account and strategy before display-name shortening',()=>{
 const raw=fundDetailFixture(),before=JSON.stringify(raw),f=projected(raw),funds=f.built.input.classification.fundDistributions;
 for(const fund of funds){
  const holdings=fund.groups.flatMap(g=>g.holdings),source=raw.classification.positions.filter(p=>p.sharesightCategory===fund.name);
  assert.equal(holdings.length,source.length);assert.equal(new Set(holdings.map(h=>h.sourceRow)).size,source.length);
  for(const group of fund.groups){assert.equal(group.holdings.reduce((n,h)=>n+h.valueCents,0),group.valueCents);assert.ok(group.holdings.every((h,i)=>i===0||group.holdings[i-1].valueCents>=h.valueCents));}
  for(const h of holdings){const r=source.find(p=>p.sourceRow===h.sourceRow);assert.deepEqual(h,{sourceRow:r.sourceRow,account:r.account,name:r.name,securityCode:r.securityCode,market:r.market,valueCents:Math.round(r.valueUSD*100)});}
  assert.equal(fund.groups.length,2);assert.equal(fund.groups.find(g=>g.name==='策略甲').holdings.length,3);
  assert.equal(new Set(holdings.map(h=>h.account)).size,2);
 }
 assert.equal(JSON.stringify(raw),before);
 for(const edit of [h=>h.account=raw.accounts[7],h=>h.name='Invented label',h=>h.securityCode='Invented code',h=>h.valueCents++]){const bad=structuredClone(f.built.input);edit(bad.classification.fundDistributions[0].groups[0].holdings[0]);assert.throws(()=>f.source.verifyBrowserSourceAssociations(raw,bad,{scopeHash:f.scope,now:f.now}));}
 const old=createOfficialRatioSourceCore().build(raw,{sourceSha256:f.sha,sourceBytes:f.bytes.length,includeFundHoldings:false});
 assert.doesNotThrow(()=>f.source.verifyBrowserSourceAssociations(raw,old.input,{scopeHash:f.scope,now:f.now}));
 const stripped=structuredClone(f.built.input);for(const fund of stripped.classification.fundDistributions)for(const group of fund.groups)delete group.holdings;assert.deepEqual(stripped,old.input);
});
test('fund detail snapshot binds accounts and sums, renders collapsed mobile lists and honest target denominators',async t=>{
 const f=await authenticated(t,fundDetailFixture()),read=await f.snapshot.verify(f.signed,f.manager,{now:f.now}),html=f.ratio.render(read.model);
 assert.equal((html.match(/class="ratio-distribution-details"/g)||[]).length,2);assert.equal((html.match(/class="ratio-fund-holding"/g)||[]).length,12);
 assert.match(html,/组合参考目标：35%（占总资产）/);assert.match(html,/组合参考目标：15%（占总资产）/);assert.match(html,/各策略的参考目标未设置/);assert.match(html,/data-security-code="策略甲-渠道-2021-10-Synthetic Shared E-1"/);assert.doesNotMatch(html,/<details[^>]* open|NaN|Infinity/);
 for(const change of [d=>d[0].groups[0].holdings[0].account='Unknown account',d=>d[0].groups[0].holdings[0].valueCents++,d=>d[0].groups[0].holdings.reverse(),d=>d[0].groups[0].holdings[0].name='',d=>d[0].groups[0].holdings[0].sourceRow=d[1].groups[0].holdings[0].sourceRow,d=>delete d[0].groups[0].holdings]){const bad=structuredClone(f.model);change(bad.classificationSummary.fundDistributions);await assert.rejects(f.ratio.validateModel(bad));}
 const prior=await authenticated(t,fundDetailFixture(),{includeFundHoldings:false}),old=await prior.snapshot.verify(prior.signed,prior.manager,{now:prior.now});assert.match(prior.ratio.render(old.model),/此历史快照未包含账户及持仓明细/);
 const escaped=structuredClone(f.model);escaped.classificationSummary.fundDistributions[0].groups[0].holdings[0].name='<img src=x onerror=alert(1)>';await f.ratio.validateModel(escaped);assert.doesNotMatch(f.ratio.render(escaped),/<img src=x/);
});
test('distribution validation rejects forged totals, duplicate groups and wrong order; rendering rounds to 100%',async t=>{
 const f=await authenticated(t),original=f.model.classificationSummary.fundDistributions;
 assert.equal(original.length,2);
 for(const change of [d=>d[0].totalCents++,d=>d[0].groups[0].valueCents++,d=>d[0].groups.push({...d[0].groups[0]}),d=>d.reverse(),d=>d[0].groups[0].name='',d=>d[0].groups[0].valueCents=-1]){const m=structuredClone(f.model);change(m.classificationSummary.fundDistributions);await assert.rejects(f.ratio.validateModel(m));}
 const m=structuredClone(f.model),d=m.classificationSummary.fundDistributions[0];
 for(const f of m.classificationSummary.fundDistributions)for(const g of f.groups)delete g.holdings;
 d.groups=[{name:'合成长中文分类用于手机换行不会改变基金策略甲',valueCents:16334},{name:'合成策略乙',valueCents:16333},{name:'未分类',valueCents:16333}];
 await f.ratio.validateModel(m);const html=f.ratio.render(m),section=html.split('<h2>常青基金分布</h2>')[1].split('</section>')[0];
 assert.equal([...section.matchAll(/aria-valuenow="([\d.]+)"/g)].reduce((s,x)=>s+Math.round(Number(x[1])*100),0),10000);
 assert.ok(html.indexOf('股票四类配置')<html.indexOf('常青基金分布'));assert.ok(html.indexOf('常青基金分布')<html.indexOf('对冲基金分布'));assert.ok(html.indexOf('对冲基金分布')<html.indexOf('All Together · 四类前五'));
 const old=structuredClone(f.model);delete old.classificationSummary.fundDistributions;await f.ratio.validateModel(old);assert.doesNotMatch(f.ratio.render(old),/常青基金分布/);
 const zero=structuredClone(m),z=zero.classificationSummary;delete z.assetAllocation;z.totalValueUSD-=d.totalCents/100;z.classes.find(g=>g.name==='常青基金').totalValueUSD=0;z.fundDistributions[0]={name:'常青基金',totalCents:0,groups:[{name:'未分类',valueCents:0}]};await f.ratio.validateModel(zero);assert.doesNotMatch(f.ratio.render(zero),/NaN|Infinity/);
});

function sixAllocationFixture(){
 const raw=syntheticOfficialSource(),account=raw.accounts[9];
 const p={sourceRow:901,account,name:'Synthetic defensive holding',securityCode:'DEF-OTHER',market:'TEST',sharesightCategory:'防御资产',valueUSD:12.34,quantity:1};
 raw.classification.positions.push(p);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;
 raw.exposure.rows.push({sourceRow:901,account,securityCode:p.securityCode,market:p.market,name:p.name,withinETF:null,ownership:'Direct',valueUSD:34.56,sourcePercentage:null});
 const c={sourceRow:902,account,name:'Synthetic extra cash',sharesightCategory:'Cash Accounts',valueUSD:1.23};
 raw.classification.cashAccounts.push(c);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;
 raw.exposure.rows.push({sourceRow:902,account,securityCode:null,market:null,name:c.name,withinETF:null,ownership:'Cash',valueUSD:2.35,sourcePercentage:null});
 raw.exposure.canonicalDataRows+=2;raw.exposure.allWorksheetXmlRows+=2;
 return raw;
}
test('six asset categories conserve all accounts, separate defense and themes, and never use look-through values',()=>{
 const raw=sixAllocationFixture(),f=projected(raw),c=f.built.input.classification,a=c.assetAllocation;
 assert.deepEqual(a.groups.map(g=>[g.name,g.valueCents,g.targetPct]),[['PE/VC',49000,0],['对冲基金',49000,15],['常青基金',49000,35],['股票市场',16000,40],['现金类',2357,8],['主题投资',4700,2]]);
 assert.equal(a.totalCents,170057);assert.equal(a.totalCents,Math.round(c.totalValueUSD*100));assert.equal(a.groups.reduce((n,g)=>n+g.valueCents,0),a.totalCents);assert.equal(a.groups.reduce((n,g)=>n+g.targetPct,0),100);
 assert.deepEqual(a.groups[4].accounts,[{name:raw.accounts[9],valueCents:1357},{name:'IB-HK',valueCents:500},{name:'NOAH-HK',valueCents:500}]);
 for(const g of a.groups)assert.equal(g.accounts.reduce((n,r)=>n+r.valueCents,0),g.valueCents);
 assert.notEqual(a.totalCents,Math.round(f.built.input.exposure.summary.totalValueUSD*100));
 const prior=createOfficialRatioSourceCore().build(raw,{sourceSha256:f.sha,sourceBytes:f.bytes.length,includeAssetAllocation:false});
 const next=structuredClone(f.built.input);delete next.classification.assetAllocation;assert.deepEqual(next,prior.input);
 assert.deepEqual(f.built.companyContext,prior.companyContext);assert.deepEqual(f.built.input.book,prior.input.book);
 assert.doesNotThrow(()=>f.source.verifyBrowserSourceAssociations(raw,prior.input,{scopeHash:f.scope,now:f.now}));
 const tampered=structuredClone(f.built.input);tampered.classification.assetAllocation.groups[4].accounts[0].name='IB-HK';assert.throws(()=>f.source.verifyBrowserSourceAssociations(raw,tampered,{scopeHash:f.scope,now:f.now}));
});
test('six asset categories use exact source classifications, not symbols, fuzzy names or leverage multiples',()=>{
 const raw=sixAllocationFixture(),p=raw.classification.positions.find(p=>p.securityCode==='VSTL');
 // A leveraged product is still its actual direct asset value in its declared category.
 p.securityCode='TQQQ';for(const r of raw.exposure.rows){if(r.securityCode==='VSTL')r.securityCode='TQQQ';if(r.withinETF==='VSTL.NASDAQ')r.withinETF='TQQQ.NASDAQ';}
 assert.equal(projected(raw).built.input.classification.assetAllocation.groups[5].valueCents,4700);
 p.sharesightCategory='美国科技';const moved=projected(raw).built.input.classification.assetAllocation;
 assert.equal(moved.groups[3].valueCents,18000);assert.equal(moved.groups[5].valueCents,2700);assert.equal(moved.totalCents,170057);
 p.sharesightCategory='Unmapped';assert.throws(()=>projected(raw),/RATIO_OFFICIAL_SOURCE_REFUSED/);
 const bytes=Buffer.from(JSON.stringify(raw));assert.doesNotThrow(()=>createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(bytes),sourceBytes:bytes.length,includeAssetAllocation:false}));
});
test('six-category snapshot validates targets, account membership, sums and renders zero reference without hiding assets',async t=>{
 const f=await authenticated(t,sixAllocationFixture()),result=await f.snapshot.verify(f.signed,f.manager,{now:f.now});
 for(const edit of [a=>a.totalCents++,a=>a.groups[0].targetPct=1,a=>a.groups.reverse(),a=>a.groups[4].valueCents++,a=>a.groups[4].accounts[0].valueCents++,a=>a.groups[4].accounts[0].name='Unknown account',a=>a.groups[4].accounts.push({...a.groups[4].accounts[0]}),a=>a.groups[4].accounts.reverse(),a=>a.groups[0].valueCents=-1,a=>a.groups[4].extra=true]){
  const bad=structuredClone(f.model);edit(bad.classificationSummary.assetAllocation);await assert.rejects(f.ratio.validateModel(bad));
 }
 const html=f.ratio.render(result.model),overview=html.split('<section class="card ratio-asset-overview')[1].split('</table>')[0];
 assert.equal((overview.match(/<tr>/g)||[]).length,7);assert.match(html,/<div class="ratio-total-summary">[^]*?总资产（USD）/);assert.doesNotMatch(overview,/<tfoot>/);assert.match(overview,/PE\/VC<small class="ratio-overview-weights">[\d.]+%／0%[^]*?class="ratio-money-precise">490\.00/);assert.match(overview,/资产分类截至 2026-10-29/);assert.doesNotMatch(overview,/2026-10-30/);
 assert.match(html,/参考目标合计100%/);assert.match(html,/二级市场 · 直接持仓前五/);assert.doesNotMatch(html,/DEF-OTHER/);assert.match(html,/不代表卖出指令/);assert.doesNotMatch(html,/NaN|Infinity|<details[^>]* open/);
 const old=structuredClone(f.model);delete old.classificationSummary.assetAllocation;await f.ratio.validateModel(old);assert.match(f.ratio.render(old),/四类资产配置总览/);assert.doesNotMatch(f.ratio.render(old),/ratio-six-allocation/);
 const zero=sixAllocationFixture();for(const p of zero.classification.positions)if(p.sharesightCategory==='VC/PE')p.valueUSD=0;
 const z=await authenticated(t,zero);await z.ratio.validateModel(z.model);assert.match(z.ratio.render(z.model),/PE\/VC<small class="ratio-overview-weights">0\.00%／0%[^]*?class="ratio-money-precise">0\.00/);
});

test('fund display merges exact dated names only within the same class strategy and account',async t=>{
 const raw=fundDetailFixture();
 for(const category of ['常青基金','对冲基金']){
  const rows=raw.classification.positions.filter(p=>p.sharesightCategory===category);
  for(const i of [1,2,3]){
   const p=rows[i],linked=raw.exposure.rows.find(r=>r.account===p.account&&r.securityCode===p.securityCode);
   const name=i===3?'Synthetic Shared E-2':'Synthetic Shared E-1';
   p.securityCode=`策略甲-渠道-${2021+i}-10-${name}`;p.name='Synthetic wrong display alias';
   // Row 2 deliberately keeps another account; row 3 keeps another share class.
   if(i!==2)p.account=rows[0].account;
   linked.securityCode=p.securityCode;linked.name=p.name;linked.account=p.account;
  }
  const extra={...rows[4],sourceRow:950+(category==='常青基金'?0:1),securityCode:'策略乙-2026-07-Synthetic Seventh',valueUSD:12};
  raw.classification.positions.push(extra);raw.classification.canonicalDataRows++;raw.classification.allWorksheetXmlRows++;
  raw.exposure.rows.push({sourceRow:extra.sourceRow,account:extra.account,securityCode:extra.securityCode,market:extra.market,name:extra.name,withinETF:null,ownership:'Direct',valueUSD:12,sourcePercentage:null});raw.exposure.canonicalDataRows++;raw.exposure.allWorksheetXmlRows++;
 }
 const f=await authenticated(t,raw),read=await f.snapshot.verify(f.signed,f.manager,{now:f.now}),before=JSON.stringify(read.model),html=f.ratio.render(read.model);
 assert.equal((html.match(/data-source-count="2"/g)||[]).length,2,'one merged row in each fund class');
 assert.equal((html.match(/class="ratio-fund-holding"/g)||[]).length,12);
 assert.match(html,/同分类、同账户、年月后完整名称相同/);
 for(const fund of read.model.classificationSummary.fundDistributions){
  const section=html.split('<h2>'+fund.name+'分布</h2>')[1].split('<section class="card ')[0];
  const rows=[...section.matchAll(/class="ratio-fund-holding"[^>]*><span[^>]*>([^<]*)<\/span><span>USD ([\d,.]+)<\/span>/g)];
  assert.equal(rows.length,6);assert.equal(rows.filter(x=>x[1]==='Synthetic Shared E-1').length,2,'another account stays separate');
  assert.equal(rows.filter(x=>x[1]==='Synthetic Shared E-2').length,1,'share class stays separate');
  assert.equal(rows.reduce((n,x)=>n+Math.round(Number(x[2].replaceAll(',',''))*100),0),fund.totalCents);
  assert.equal(fund.groups.flatMap(g=>g.holdings).length,7,'signed source rows remain complete');
 }
 assert.equal(JSON.stringify(read.model),before,'presentation must not rewrite the authenticated model');
});
test('fund grouping uses exactly the existing top-five date/name parser, including punctuation and classes',()=>{
 const page=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),module=fs.readFileSync(new URL('./fee-ratio-management.mjs',import.meta.url),'utf8');
 const browser=page.slice(page.indexOf('function ratioHoldingDisplayName('),page.indexOf('\nfunction styleRatioReport('));
 const a=module.indexOf('  function fundHoldingDisplayName('),b=module.indexOf('\n  function renderRatioModel(',a);
 const shared=module.slice(a,b).split('\n').map(line=>line.startsWith('  ')?line.slice(2):line).join('\n').trim();
 assert.equal(shared.replace('fundHoldingDisplayName','ratioHoldingDisplayName'),browser.trim());
});

// Counterexample (2026-11-10): an official export dated by its Hong Kong
// capture date is valid for the official projection, so its age is counted in
// Hong Kong days; the UTC date of the same instant is still the day before.
test('Hong Kong-dated official exports are not future before UTC midnight; future, stale and 36h guards remain',()=>{
 const check=(asOf,capturedAt,now)=>{
  const raw=syntheticOfficialSource();
  for(const r of ['classification','exposure']){raw[r].asOf=asOf;raw[r].capturedAt=capturedAt;raw[r].dateEvidence='Showing as at '+Number(asOf.slice(8))+' Nov 2026';}
  const bytes=Buffer.from(JSON.stringify(raw)),scope=hash(JSON.stringify([...raw.accounts].sort()));
  let built;try{built=createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(bytes),sourceBytes:bytes.length});}catch{return 'official-refused';}
  try{createRatioSourceCore(()=>scope).verifyBrowserSourceAssociations(raw,built.input,{scopeHash:scope,now:new Date(now)});return 'accepted';}catch{return 'source-refused';}
 };
 assert.equal(check('2026-11-10','2026-11-09T23:30:00.000Z','2026-11-09T23:45:00.000Z'),'accepted','HKT 07:45 is still UTC 2026-11-09');
 assert.equal(check('2026-11-10','2026-11-09T23:30:00.000Z','2026-11-10T00:30:00.000Z'),'accepted');
 assert.equal(check('2026-11-11','2026-11-09T23:30:00.000Z','2026-11-09T23:45:00.000Z'),'official-refused','a date beyond the capture HKT date is future');
 assert.equal(check('2026-11-05','2026-11-09T23:30:00.000Z','2026-11-09T23:45:00.000Z'),'source-refused','five Hong Kong days old');
 assert.equal(check('2026-11-06','2026-11-09T23:30:00.000Z','2026-11-09T23:45:00.000Z'),'accepted','four Hong Kong days old');
 assert.equal(check('2026-11-10','2026-11-09T23:30:00.000Z','2026-11-11T11:30:00.001Z'),'source-refused','capture older than 36 hours');
 assert.equal(check('2026-11-10','2026-11-09T23:30:00.000Z','2026-11-09T23:29:59.999Z'),'source-refused','capture after the verifier clock');
});
