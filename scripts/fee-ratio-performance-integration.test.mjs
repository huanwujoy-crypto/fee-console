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
async function fixture(t,edit=x=>x,allocation=syntheticOfficialSource()){
 const f=await authenticated(t,allocation),raw={schemaVersion:'sharesight-private-performance-v1',accounts:[...f.raw.accounts],allocation:structuredClone(f.raw),performance:performance(f.raw),performanceCapturedAt:'2026-10-30T05:50:00.000Z'};
 edit(raw);const original=bytes(raw),base=createOfficialRatioSourceCore().build(raw.allocation,{sourceSha256:hash(original),sourceBytes:original.length}).input,input={...base,schema:'fee-console.ratio-sources.v3',performance:structuredClone(raw.performance)},inputBytes=bytes(input);
 const facts=f.source.verifyBrowserSourceAssociations(raw,input,{scopeHash:f.scope,now:f.now}),model=await buildRatioModel(input,{kind:'snapshot',targetDate:'2026-10-30',viewCore:f.ratio,previewOnly:true,now:f.now});
 model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-library-association',associationId:'c'.repeat(64),managerScopeId:f.manager.recipient.scopeId,sourceVersion:0,migrationPending:facts.migrationPending,classificationDeltaCents:facts.classificationDeltaCents,exposureDeltaCents:facts.exposureDeltaCents};
 model.companyExposure=facts.companyExposure;model.sourceDates=facts.sourceDates;model.classificationSummary=facts.classificationSummary;
 const args={originalBytes:new Uint8Array(original),inputBytes:new Uint8Array(inputBytes),model,recipient:f.manager.recipient,sourceSha256:hash(original),inputSha256:hash(inputBytes),libraryVersion:0,now:f.now};
 const proof=await f.snapshot.verifyOriginal(args),candidate=await f.snapshot.candidate({model,recipient:f.manager.recipient,proof,previous:f.signed,now:f.now}),signed=await f.snapshot.authenticate(candidate,proof,f.manager,{previous:f.signed,profileSha256:'b'.repeat(64),now:f.now});
 return {...f,raw,input,original,inputBytes,facts,model,args,proof,performanceSigned:signed};
}
test('native aggregates bind to original bytes, encrypt, authenticate, reopen and render without individual rates',async t=>{
 const f=await fixture(t),r=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(r.model);
 assert.equal(r.source.sourceDates.performance,'2026-10-30');assert.deepEqual(r.model.performance,f.raw.performance);assert.match(html,/收益截至 2026-10-30/);assert.match(html,/8.25% p.a./);assert.match(html,/-2.10%/);assert.match(html,/虚拟持仓/);assert.doesNotMatch(html,/SYNTHETIC-CLOSED/);
 assert.equal(r.model.feeCalculationReceipt,undefined);assert.deepEqual(r.model.classificationSummary,f.built.input.classification);assert.deepEqual(r.model.book.holdings,f.model.book.holdings);assert.equal(r.source.capturedAt,f.signed.body.source.capturedAt);
 const holdings=html.match(/<li class="ratio-fund-holding"[^]*?<\/li>/g)||[];assert.ok(holdings.every(x=>!x.includes('ratio-returns')));
});
test('tampered return, missing return source, fabricated proof and account mismatch cannot obtain publication proof',async t=>{
 const f=await fixture(t);
 for(const change of [m=>m.performance.reports[0].rows[0].returnPct++,m=>delete m.performance,m=>m.performance.accounts.pop(),m=>m.sourceDates.performance='2026-10-29']){const model=structuredClone(f.model);change(model);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model}));}
 const input=structuredClone(f.input);input.performance.reports[0].rows[0].returnPct++;const changed=bytes(input);await assert.rejects(f.snapshot.verifyOriginal({...f.args,inputBytes:new Uint8Array(changed),inputSha256:hash(changed)}));
 await assert.rejects(f.snapshot.candidate({model:f.model,recipient:f.manager.recipient,proof:structuredClone(f.proof),now:f.now}));
});
test('performance evidence cannot refresh old allocation capture or use future/old returns',async t=>{
 for(const edit of [r=>r.performanceCapturedAt='2026-11-01T00:00:00.000Z',r=>r.performanceCapturedAt='2026-10-27T00:00:00.000Z',r=>r.performance.asOf='2026-10-31',r=>r.accounts.reverse()])await assert.rejects(fixture(t,edit));
});
test('accepted native benchmark scope survives authentication and discloses without changing allocation',async t=>{
 const allocation=JSON.parse(JSON.stringify(syntheticOfficialSource()).replaceAll('Synthetic 7','Citi-HK & 地产四期'));
 const f=await fixture(t,r=>{for(const p of r.performance.reports){p.rows[0].scope=scope('All Together');p.rows[0].members.push({account:r.accounts[9],market:'NASDAQ',securityCode:'QQQ'});p.unavailable=p.unavailable.filter(x=>x.scope.name!=='All Together');}},allocation);
 const reopened=await f.snapshot.verify(f.performanceSigned,f.manager,{now:f.now}),html=f.ratio.render(reopened.model);
 assert.match(html,/含 1 项用于程序取值的模拟基准/);assert.match(html,/未剔除其影响/);assert.match(html,/8.25% p.a./);
 assert.deepEqual(reopened.model.classificationSummary,f.built.input.classification);assert.deepEqual(reopened.model.book.holdings,f.model.book.holdings);
 assert.deepEqual(reopened.model.performance,f.raw.performance);assert.equal(reopened.model.feeCalculationReceipt,undefined);
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
 const f=await fixture(t,raw=>{for(const [i,r]of raw.performance.reports.entries()){const id=String(i+6);r.additionalSources=[{libraryFileId:'libfile_'+id.repeat(32),version:0,sha256:id.repeat(64),locator:'Synthetic auxiliary original'}];r.rows[0].sourceFileId=r.additionalSources[0].libraryFileId;}}),bundleId=hash(Buffer.concat([f.original,f.inputBytes])),prefix='inputs/'+bundleId+'/',plan={mode:'publish',previousBodySha256:await f.ratio.digest(f.signed.body),bundleId,original:{name:prefix+'original.json',generation:'1',sha256:hash(f.original)},input:{name:prefix+'input.json',generation:'2',sha256:hash(f.inputBytes)},library:{fileId:'libfile_'+'9'.repeat(32),version:0}},identity={gistId:'0'.repeat(32),ownerId:42};
 let current=bytes(f.signed),patches=0,claimed=0,deleted=0;const io={
 async readDestination(name){assert.equal(name,RATIO_CLOUD_FILE);return {id:identity.gistId,ownerId:42,authenticatedUserId:42,public:false,revision:(patches?'b':'a').repeat(40),recipientBytes:bytes(f.manager.recipient),snapshotBytes:Buffer.from(current)};},
 async readInput(s){return {generation:s.generation,bytes:Buffer.from(s.name.endsWith('original.json')?f.original:f.inputBytes)};},
 async claimOnce(k,b,options){assert.deepEqual(options,{ifGenerationMatch:0});return ++claimed===1?'CREATED':'EXISTS';},
 async patchSnapshot(body){assert.deepEqual(Object.keys(body.files),[RATIO_CLOUD_FILE]);patches++;current=Buffer.from(body.files[RATIO_CLOUD_FILE].content);},
 async saveReceipt(){},async cleanupLocal(){},async deleteInputs(specs){assert.deepEqual(specs,[plan.original,plan.input]);deleted++;}};
 const result=await createRatioCloudPublisher({exposureCore:f.exposure}).run({plan,identity,manager:f.manager,io,clock:()=>f.now});
 assert.equal(result.status,'PUBLISHED_CONFIRMED');assert.equal(patches,1);assert.equal(claimed,1);assert.equal(deleted,1);
 const accepted=await f.snapshot.verify(JSON.parse(current),f.manager,{now:f.now});assert.deepEqual(accepted.model.performance,f.raw.performance);
 const tampered=structuredClone(f.model);tampered.performance.reports[0].additionalSources[0].sha256='e'.repeat(64);await assert.rejects(f.snapshot.verifyOriginal({...f.args,model:tampered}));
});
test('browser uses exact tested factories and preserves existing note/session code',()=>{
 const actual=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 // The required support-only PR leaves the prior page intact. Accept only
 // either exact reviewed page, and prove the frozen transition before use.
 assert.ok([aggregateUiFixture.priorSha256,aggregateUiFixture.nextSha256].includes(hash(actual)));
 const page=hash(actual)===aggregateUiFixture.priorSha256?aggregateUiStage(actual):actual;
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
