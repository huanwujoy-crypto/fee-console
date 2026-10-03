import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {observeFee} from './fee-observation.mjs';
const NOW='2026-10-02T09:00:00Z',DATE='2026-10-01',ID=365873934;
const fixture=()=>{const bytes=Buffer.from(JSON.stringify({enc:true,v:3,data:Buffer.alloc(40).toString('base64')})),health={schema:'fee-console.daily-health.v1',checkedAt:'2026-10-02T08:49:22.743Z',targetDate:DATE,sourceDates:{schwab:DATE,webull:DATE,benchmark:DATE},outcome:'updated',dataSha256:crypto.createHash('sha256').update(bytes).digest('hex'),errorCode:null};return {workflow:{id:ID,state:'active'},runs:[],expectedDate:DATE,now:NOW,publicHealth:health,mainHealth:structuredClone(health),publicData:bytes,mainData:bytes,mainSha:'a'.repeat(40)};};
const run=(event='schedule',conclusion='success',status='completed')=>({workflow_id:ID,head_branch:'main',id:900,event,conclusion,status,created_at:'2026-10-02T04:00:00Z'});
test('today public recovery does not hide an unobserved scheduled run or infer its cause',()=>{
 const x=fixture();x.runs=[run('workflow_dispatch','failure')];const r=observeFee(x);
 assert.equal(r.publication.state,'current');assert.equal(r.trigger.state,'no-scheduled-run-observed');assert.equal(r.trigger.cause,'not-inferred');assert.equal(r.trigger.scheduledRunsToday,0);
 assert.deepEqual(r.diagnostics.map(d=>d.code),['NO_SCHEDULED_RUN_OBSERVED','FAILED_BEFORE_PUBLIC_REFRESH']);assert.equal(r.needsAttention,true);
});
test('queued scheduled jobs are observed, not misreported as lost events',()=>{
 const x=fixture();x.runs=[run('schedule',null,'queued')];const r=observeFee(x);assert.equal(r.trigger.state,'scheduled-run-observed');assert.equal(r.producer.state,'in-progress');assert.equal(r.needsAttention,false);
});
test('manual success, unrelated workflow and a non-main branch cannot satisfy scheduled-run observation',()=>{
 for(const change of [r=>r.event='workflow_dispatch',r=>r.workflow_id=1,r=>r.head_branch='codex/xuan-test']){const x=fixture(),v=run();change(v);x.runs=[v];assert.equal(observeFee(x).trigger.state,'no-scheduled-run-observed');}
});
test('before the observation deadline and on unscheduled days, no missing-run claim is made',()=>{
 for(const [now,state]of [['2026-10-02T03:40:00Z','before-observation-deadline'],['2026-10-04T04:30:00Z','not-scheduled-today']]){const x=fixture();x.now=now;x.publicHealth.checkedAt=new Date(Date.parse(now)-60000).toISOString();x.mainHealth=structuredClone(x.publicHealth);assert.equal(observeFee(x).trigger.state,state);}
});
test('target lag, stale receipt and public/main byte mismatch have separate stage diagnostics',()=>{
 const x=fixture();x.runs=[run()];for(const h of [x.publicHealth,x.mainHealth]){h.targetDate='2026-09-30';h.sourceDates={schwab:h.targetDate,webull:h.targetDate,benchmark:h.targetDate};h.checkedAt='2026-10-01T09:00:00Z';}
 const r=observeFee(x);assert.ok(r.diagnostics.some(d=>d.code==='PUBLIC_TARGET_DATE_LAG'));assert.ok(r.diagnostics.some(d=>d.code==='NO_FRESH_PUBLIC_HEALTH_TODAY'));
 const wrong=fixture();wrong.runs=[run()];wrong.publicData=Buffer.from('different');const drift=observeFee(wrong);assert.ok(drift.diagnostics.some(d=>d.code==='PUBLIC_HEALTH_DATA_HASH_MISMATCH'));assert.ok(drift.diagnostics.some(d=>d.code==='PUBLIC_DIFFERS_FROM_MAIN'));
});
test('public-only green checks explicitly do not claim private receipt or investor acceptance',()=>{
 const x=fixture();x.runs=[run()];const r=observeFee(x);assert.equal(r.needsAttention,false);assert.equal(r.privateReceiptAndInvestorAcceptance,'not-tested-by-this-public-only-tool');
});
test('malformed evidence and arguments never echo private strings through diagnostics',()=>{
 const x=fixture();x.publicHealth={targetDate:'private-secret',checkedAt:'private-secret',outcome:'private-secret',errorCode:'private-secret'};x.runs=[{...run(),status:'private-secret',conclusion:'private-secret'}];x.mainSha='private-secret';assert.doesNotMatch(JSON.stringify(observeFee(x)),/private-secret/);
 const p=spawnSync(process.execPath,['scripts/fee-observation.mjs','--token=private-secret'],{encoding:'utf8'});assert.equal(p.status,1);assert.match(p.stdout,/OBSERVATION_ARGUMENT_INVALID/);assert.doesNotMatch(p.stdout+p.stderr,/private-secret/);
});
test('observer has no dispatch, mutation, notification or financial credential path',()=>{
 const s=fs.readFileSync(new URL('./fee-observation.mjs',import.meta.url),'utf8');assert.doesNotMatch(s,/method:\s*['"](?:POST|PATCH|PUT|DELETE)|workflow_dispatch.*method|find-generic-password|process\.env\.FEE|send_message|createCommitOnBranch/);
 assert.match(s,/--request','GET/);assert.match(s,/COLLECTION_MAIN_CHANGED_RETRY/);assert.match(s,/COLLECTION_RUN_HISTORY_INCOMPLETE/);
});

test('matching hashes cannot bless an unencrypted or malformed public data envelope',()=>{
 const x=fixture();x.runs=[run()];x.publicData=Buffer.from('{"v":4,"private":"synthetic"}');x.mainData=x.publicData;const digest=crypto.createHash('sha256').update(x.publicData).digest('hex');x.publicHealth.dataSha256=digest;x.mainHealth.dataSha256=digest;const r=observeFee(x);assert.ok(r.diagnostics.some(d=>d.code==='PUBLIC_ENVELOPE_INVALID'));assert.ok(r.diagnostics.some(d=>d.code==='MAIN_ENVELOPE_INVALID'));assert.equal(r.needsAttention,true);
});
