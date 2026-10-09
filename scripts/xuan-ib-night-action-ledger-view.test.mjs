import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
import {validateLedgerView,validateLedgerPublication,trustedProfileAtAssociation,validateReportProfile,profileBlob,LEDGER_PROFILE} from './xuan-ib-night-action-ledger-view.mjs';
import {renderNightActionReport,extractNightActionModel} from './xuan-ib-night-action-view.mjs';import {validateNightActionHtml} from './xuan-ib-night-action-guard.mjs';
import {classifySleepPublication} from './xuan-ib-sleep-priority.mjs';import {selectNewestCandidate} from './xuan-ib-promotion.mjs';
import {fixture,prepared} from '../cloud/xuan-preopen/sharesight_ledger_fixtures.mjs';
const clock=Date.parse('2026-10-09T05:00:00.000Z');
test('new partial schema is explicitly classified and cannot count as completed publication',async()=>{
 const {html}=await prepared();assert.deepEqual(classifySleepPublication(html),{kind:'sharesight-ledger-view',dataDate:'2026-10-09',priorityKey:null,eligibleAtEpoch:null});
});
test('same-day higher evidence always wins; partial cannot downgrade complete/IB reads or priority, even with newer commit',()=>{
 const date='2026-10-09',state=kind=>({kind,dataDate:date,priorityKey:kind==='priority'?`pm:${date}`:null,eligibleAtEpoch:kind==='priority'?50:null});
 const meta={schemaVersion:1,sourceSha:'a'.repeat(40),sourceCommitEpoch:100,dataDate:date,htmlBlob:'b'.repeat(40)};
 const candidate=kind=>({ref:'origin/codex/xuan-ib-test',sha:'c'.repeat(40),commitEpoch:101,dataDate:date,htmlBlob:'d'.repeat(40),publication:state(kind)});
 for(const higher of ['complete-pm','limited-readback','intraday-update','priority']){
  assert.equal(selectNewestCandidate([candidate('sharesight-ledger-view')],meta,state(higher)),null);
  const high=candidate(higher),low={...candidate('sharesight-ledger-view'),sha:'e'.repeat(40),htmlBlob:'f'.repeat(40),commitEpoch:102};
  assert.equal(selectNewestCandidate([low,high],meta,state('other')).sha,high.sha);
 }
 assert.equal(selectNewestCandidate([candidate('sharesight-ledger-view')],meta,state('sharesight-ledger-view')).publication.kind,'sharesight-ledger-view');
 const old={...meta,dataDate:'2026-10-08'};assert.equal(selectNewestCandidate([candidate('sharesight-ledger-view')],old,{...state('complete-pm'),dataDate:'2026-10-08'}).dataDate,date);
});
test('trusted guard verifies target day, read bound, association and current profile with no caller policy fallback',async()=>{
 const {f,model,html}=await prepared(),options={snapshot:f.context.association,previousSourceSha:f.context.previousSourceSha,now:clock,profile:f.profile};
 assert.equal(validateNightActionHtml(html,'2026-10-09',options).status,'partial');
 for(const patch of [{profile:null},{snapshot:null},{previousSourceSha:'f'.repeat(40)},{now:clock-1},{now:clock+1800001}])assert.throws(()=>validateNightActionHtml(html,'2026-10-09',{...options,...patch}));
 for(const change of [m=>m.sourceDate='2026-10-07',m=>m.captureStartedAt='2026-10-09T04:54:59.000Z',m=>m.evidenceSha256='e'.repeat(64),m=>m.sourceHash='e'.repeat(64),m=>{m.allocation.total=2000;for(const r of m.allocation.categories)r.marketValue*=2;},m=>m.association.previousSourceSha='f'.repeat(40)]){
  const m=structuredClone(model);change(m);assert.throws(()=>{const h=renderNightActionReport(m);validateNightActionHtml(h,'2026-10-09',options);});
 }
});
test('strict schema protects unknown capabilities, zero-instead-of-missing, injection and receipt mode relabeling',async()=>{
 const {model,html}=await prepared();
 for(const change of [m=>m.mode='normal',m=>m.schemaVersion=5,m=>m.syncCompletion=true,m=>m.cashReconciliation='matched',m=>m.capabilities.positions=true,m=>m.allocation.categories[0].label='<script>',m=>m.profileBlob+='\n',m=>m.captureStartedAt='2026-02-30T05:00:00.000Z']){const m=structuredClone(model);change(m);assert.throws(()=>validateLedgerView(m));}
 assert.throws(()=>extractNightActionModel(html+html));
});
test('fresh association commit is the only profile lookup source; unknown/duplicate/large encoding and arbitrary revision refuse',()=>{
 const f=fixture(),calls=[],snapshot=f.context.association;
 const profile=trustedProfileAtAssociation(snapshot,{runGit:args=>{calls.push(args);return f.text;}});assert.equal(profile.profile,LEDGER_PROFILE);
 assert.deepEqual(calls,[['show',`${snapshot.policyCommit}:claude/xuan-ib-preopen-report-profile-v1.json`]]);
 for(const text of ['{}',JSON.stringify({...f.config,profile:'unknown'},null,2)+'\n','{"schemaVersion":1,"purpose":"xuan-preopen-report-profile","profile":"normal","profile":"sharesight-ledger-view-v1"}'])assert.throws(()=>trustedProfileAtAssociation(snapshot,{runGit:()=>text}));
 let reads=0;assert.throws(()=>trustedProfileAtAssociation({...snapshot,policyCommit:'HEAD:secret'},{runGit:()=>{reads++;return f.text;}}));assert.equal(reads,0);
 assert.equal(validateReportProfile({...f.config,profile:'normal'}),'normal');assert.equal(profileBlob(f.text).length,40);
});
test('existing trusted workflow archives the one calendar dependency and schema route remains inside trusted script guard',()=>{
 const validate=fs.readFileSync(new URL('../.github/workflows/validate-xuan-ib-handover.yml',import.meta.url),'utf8');assert.match(validate,/git archive origin\/main -- cloud\/xuan-preopen\/calendar\.mjs/);assert.match(validate,/scripts\/xuan-ib-night-action-ledger-view\.mjs/);
 const producer=fs.readFileSync(new URL('../.github/workflows/xuan-preopen-cloud-producer.yml',import.meta.url),'utf8');assert.match(producer,/sharesight-ledger-view/);assert.doesNotMatch(producer,/operation:|diagnostic_date:|cancel-in-progress: true/);
});
test('CLI date/path/unsafe arguments fail before any cloud identity or source read',()=>{
 for(const args of [['--source-date','2026-10-08'],['--ledger-readback','delivery/evil'],['--unknown']]){
  let result;try{execFileSync(process.execPath,['cloud/xuan-preopen/daily.mjs',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});assert.fail('CLI unexpectedly accepted unsafe arguments');}catch(e){assert.equal(e.status,1);result=e.stdout;}assert.match(result,/DAILY_ARGUMENTS_INVALID/);assert.doesNotMatch(result,/NETWORK|IDENTITY|TOKEN|2026-10-08|delivery\/evil/);
 }
});
