import test from 'node:test';import assert from 'node:assert/strict';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';import {gitBlobSha} from '../../scripts/xuan-ib-publish-health.mjs';import {provesFormalAction} from './publication_proof.mjs';import {statusFixture} from './test_fixtures.mjs';
function fixture(){const f=statusFixture();const model={schemaVersion:5,dataDate:f.plan.dataDate,status:'ready',asOfHkt:'2026-10-05 14:00 HKT · 数据至 2026-10-02',replenishment:{status:'unavailable'},orders:{status:'unavailable',asOfHkt:'14:00 HKT',buys:[],sells:[]},cash:{status:'unavailable'},allocation:{status:'unavailable'},notes:[]};const html=renderNightActionReport(model),sourceSha='c'.repeat(40);return{html,model,sourceSha,plan:f.plan,meta:{dataDate:f.plan.dataDate,sourceSha,sourceCommitEpoch:f.plan.startEpoch,htmlBlob:gitBlobSha(html)}};}
test('formal publication needs exact date/source/meta/blob and real acquisition window',()=>{
 const f=fixture();assert.equal(provesFormalAction(f),true);
 for(const modify of [v=>v.meta.dataDate='2026-10-04',v=>v.meta.sourceSha='e'.repeat(40),v=>v.meta.htmlBlob='f'.repeat(40),v=>v.meta.sourceCommitEpoch--,v=>v.model.asOfHkt='2026-10-05 13:59 HKT · 数据至 2026-10-02',v=>v.model.asOfHkt='2026-10-05 15:00 HKT · 数据至 2026-10-02',v=>v.model.asOfHkt='2026-10-05 14:00 HKT · 数据至 2026-10-01']){
 const v=fixture();modify(v);if(v.model.asOfHkt!==f.model.asOfHkt){v.html=renderNightActionReport(v.model);v.meta.htmlBlob=gitBlobSha(v.html);}assert.equal(provesFormalAction(v),false);
 }
 const s=statusFixture();assert.equal(provesFormalAction({...fixture(),html:s.html}),false);
});
