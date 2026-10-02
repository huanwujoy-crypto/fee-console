import test from 'node:test';import assert from 'node:assert/strict';
import {statusFixture} from '../cloud/xuan-preopen/test_fixtures.mjs';
import {renderNightActionReport} from './xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from './xuan-ib-night-action-guard.mjs';
import {classifySleepPublication} from './xuan-ib-sleep-priority.mjs';
import {extractPrimaryDateLine,classifyEdition} from './xuan-ib-publish-health.mjs';
test('canonical value-free status has no amounts/actions and cannot prove scheduled completion',()=>{
 const f=statusFixture();assert.deepEqual(validateNightActionHtml(f.html,f.plan.dataDate,{snapshot:f.context.association,previousSourceSha:f.context.previousSourceSha,now:f.now()}),{dataDate:f.plan.dataDate,status:'data-not-ready',orderCount:0});
 assert.equal(classifySleepPublication(f.html).kind,'other');assert.equal(classifyEdition(extractPrimaryDateLine(f.html)),'adhoc');assert.ok(!f.html.includes('补仓金额 $'));assert.ok(!f.html.includes('<script'));assert.match(f.html,/非身份认证/);assert.match(f.html,/上一份报告原日期：2026-10-01/);
});
test('extra financial field, arbitrary reason, fake identity and wrong slot cannot enter canonical marker',()=>{
 for(const modify of [m=>m.cash=100,m=>m.reasonCodes=['RAW_SECRET'],m=>m.association.accountId='fictional',m=>m.slotId='old',m=>m.attempt=3]){const f=statusFixture();modify(f.model);assert.throws(()=>renderNightActionReport(f.model));}
});
test('guard independently rejects expired/revoked/new account scope, changed policy, stale/relabel/tamper',()=>{
 for(const modify of [f=>f.context.association.policy.status='revoked',f=>f.context.association.policy.accountAlias='UNAPPROVED',f=>f.context.association.policy.expiresAt='2026-10-04T00:00:00.000Z',f=>f.context.previousSourceSha='e'.repeat(40),f=>f.html+='x',f=>f.model.asOfHkt='2026-10-05 13:59 HKT']){
 const f=statusFixture();modify(f);if(f.model.asOfHkt.includes('13:59')){assert.throws(()=>renderNightActionReport(f.model));continue;}assert.throws(()=>validateNightActionHtml(f.html,f.plan.dataDate,{snapshot:f.context.association,previousSourceSha:f.context.previousSourceSha,now:f.now()}));}
 const f=statusFixture();assert.throws(()=>validateNightActionHtml(f.html,f.plan.dataDate,{snapshot:f.context.association,previousSourceSha:f.context.previousSourceSha,now:f.now()+1800001}));assert.throws(()=>validateNightActionHtml(f.html,'2026-10-06'));
});
