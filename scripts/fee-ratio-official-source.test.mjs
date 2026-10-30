// Synthetic workbooks only. No credentials, financial reads or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
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
function projected(raw=syntheticOfficialSource()){
 const bytes=Buffer.from(JSON.stringify(raw)),sha=hash(bytes),built=createOfficialRatioSourceCore().build(raw,{sourceSha256:sha,sourceBytes:bytes.length}),scope=hash(JSON.stringify([...raw.accounts].sort())),exposure={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scope},ratio=createFeeRatioCore(exposure,crypto.webcrypto),source=createRatioSourceCore(()=>scope),now=new Date('2026-10-30T06:00:00.000Z');
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
async function authenticated(t){
 const f=projected(),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ratio-official-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),p=path.join(dir,name);fs.writeFileSync(p,bytes,{mode:0o600});return {path:p,sha256:hash(bytes)};};
 const manager=await f.ratio.deriveSnapshotManager('0'.repeat(32),Buffer.alloc(32,7).toString('base64url'),'synthetic-manager-token-not-real-123'),plan={schema:'fee-console.ratio-browser-evidence-plan.v1',workspace:dir,source:write('original.json',f.bytes),input:write('input.json',f.built.input),library:{libraryFileId:'libfile_'+'9'.repeat(32),version:0},managerScopeId:manager.recipient.scopeId,localOwnerUid:process.getuid()},planPath=write('plan.json',plan).path;
 const proof=readVerifiedBrowserEvidence({planPath,expectedScopeId:manager.recipient.scopeId,input:f.built.input,now:f.now,runtime:{uid:process.getuid(),readIdentity:()=>({libraryFileId:plan.library.libraryFileId,version:0})},exposureCore:f.exposure});
 const model=await buildRatioModel(f.built.input,{kind:'snapshot',targetDate:'2026-10-30',browserEvidence:proof,managerScopeId:manager.recipient.scopeId,viewCore:f.ratio,now:f.now});
 const snapshot=createRatioSnapshotCore(f.ratio,f.exposure,createRatioSourceCore,b=>JSON.parse(Buffer.from(b)),crypto.webcrypto),args={originalBytes:new Uint8Array(f.bytes),inputBytes:new Uint8Array(fs.readFileSync(plan.input.path)),model,recipient:manager.recipient,sourceSha256:f.sha,inputSha256:plan.input.sha256,libraryVersion:0,now:f.now},original=await snapshot.verifyOriginal(args),packet=await snapshot.candidate({model,recipient:manager.recipient,proof:original,now:f.now}),signed=await snapshot.authenticate(packet,original,manager,{profileSha256:'a'.repeat(64),now:f.now});
 return {...f,model,manager,snapshot,args,signed};
}
test('full source to manager snapshot authenticates both dates, renders distinct denominators and keeps fee data outside',async t=>{
 const f=await authenticated(t),result=await f.snapshot.verify(f.signed,f.manager,{now:f.now});
 assert.deepEqual(result.source.sourceDates,f.model.sourceDates);assert.equal(result.stale,false);
 const html=f.ratio.render(result.model);
 for(const text of ['资产分类截至 2026-10-29','个股穿透截至 2026-10-30','Exposure截至 2026-10-30','黄金（GLD · NYSE）','已包含在四类资产合计中','独立下载完成时间未知','公司经济敞口前五','计算口径与合并规则'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/完整持仓|undefined|<details open/);
 assert.equal((html.match(/<details><summary>/g)||[]).length>=4,true);
 assert.equal(result.model.feeCalculationReceipt,undefined);
 const late=await f.snapshot.verify(f.signed,f.manager,{now:new Date('2026-11-02T00:00:00.000Z')});assert.equal(late.stale,true);
});
test('edited dates, summaries, downgrade, stale source, MAC and rollback cannot authenticate as a new formal snapshot',async t=>{
 const f=await authenticated(t);
 for(const change of [m=>m.sourceDates.classification='2026-10-30',m=>m.classificationSummary.totalValueUSD++,m=>m.classificationSummary.gold.valueUSD++,m=>m.schema='fee-console.ratio-view.v1',m=>delete m.sourceDates,m=>m.book.asOf='2026-10-30',m=>m.companyExposure.components[0].valueUsd++]){const model=structuredClone(f.model);change(model);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));}
 for(const change of [p=>p.body.source.sourceDates.classification='2026-10-30',p=>delete p.body.source.sourceDates,p=>p.body.source.kind='complete-original-browser-association',p=>p.authentication.mac='x']){const p=structuredClone(f.signed);change(p);await assert.rejects(f.snapshot.verify(p,f.manager,{now:f.now}));}
 const good=await f.snapshot.verify(f.signed,f.manager,{now:f.now});await assert.rejects(f.snapshot.verify(f.signed,f.manager,{now:f.now,watermark:{...good.watermark,version:2}}));
 await assert.rejects(f.snapshot.verify(f.signed,f.manager,{now:f.now,watermark:{...good.watermark,sourceDates:{classification:'2026-10-30',exposure:'2026-10-30'}}}));
});
