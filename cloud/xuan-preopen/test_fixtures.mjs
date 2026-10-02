import crypto from 'node:crypto';
import {associationPolicyBlob,createAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {planPreopen} from './calendar.mjs';
import {attemptFor,attemptPrefix} from './attempts.mjs';
export function statusFixture(time=Date.parse('2026-10-05T06:01:00Z')){
 const now=()=>time,plan=planPreopen(time),attempt=attemptFor(plan,time);
 const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt:'2026-10-10T13:30:00.000Z'};
 const snapshot={policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(time).toISOString()};
 const context={association:snapshot,previousSourceSha:'c'.repeat(40),previousMeta:{dataDate:'2026-10-01'},previousHtml:'old html'};
 const association=createAssociationReceipt(snapshot,{now:time,edition:'am',previousSourceSha:context.previousSourceSha,runId:'b'.repeat(64)});
 const model={schemaVersion:6,status:'data-not-ready',dataDate:plan.dataDate,asOfHkt:plan.dataDate+' '+new Date(time+28800000).toISOString().slice(11,16)+' HKT',sourceDate:plan.sourceDate,slotId:plan.slotId,attempt,reasonCodes:['SOURCE_ADAPTER_NOT_CONFIGURED'],association,expiresAt:policy.expiresAt,previousDataDate:context.previousMeta.dataDate,previousReportSha:context.previousSourceSha,previousSourceSha:context.previousSourceSha};
 const html=renderNightActionReport(model);
 const receipt={schemaVersion:1,mode:'private_report_check',status:'data-not-ready',dataDate:plan.dataDate,sourceDate:plan.sourceDate,slotId:plan.slotId,attempt,reasonCodes:model.reasonCodes,association,startedAt:new Date(time).toISOString(),completedAt:new Date(time).toISOString(),publication:'none',sourceCount:0,sources:[],artifact:{privateObject:attemptPrefix(plan,attempt)+'report.html',sha256:crypto.createHash('sha256').update(html).digest('hex')}};
 return{now,plan,attempt,context,model,html,receipt};
}
