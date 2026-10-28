// Synthetic phone parser fixture; no real report, account or producer evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync,execFileSync} from 'node:child_process';
import {renderPublicEodSummary,qualifyRecordedPublicSummary} from './xuan-ib-public-eod-summary.mjs';
const page=fs.readFileSync(new URL('../xuan-ib/index.html',import.meta.url),'utf8');
let parserPage=page;
if(page.includes('name="xuan-action-status" content="retired"')){
 parserPage='';for(const commit of execFileSync('git',['log','--format=%H','--','xuan-ib/index.html'],{encoding:'utf8'}).trim().split('\n')){
  const archived=execFileSync('git',['show',commit+':xuan-ib/index.html'],{encoding:'utf8'});
  if(archived.includes('const reportInfo =')&&archived.includes('const statusFor =')){parserPage=archived;break;}
 }
 assert.ok(parserPage,'retirement preserves the archived parser and its negative tests');
}
const info=parserPage.slice(parserPage.indexOf('const reportInfo ='),parserPage.indexOf('const requireExactKeys ='));
const status=parserPage.slice(parserPage.indexOf('const statusFor ='),parserPage.indexOf('function updateDecisionControl'));
const sandbox={TextDecoder,Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary'),clock:()=> 'synthetic clock'};
vm.createContext(sandbox);vm.runInContext(info+status+'\nglobalThis.reportInfo=reportInfo;globalThis.statusFor=statusFor;',sandbox);
const html=model=>`<title>XUAN · EOD 行动版</title><!-- xuan-ib-night-action-v1:${Buffer.from(JSON.stringify(model)).toString('base64url')} --><header><p>2026-10-09 · 2026-10-09 13:00 HKT · 数据至 2026-10-08</p></header>`;
const model={schemaVersion:9,mode:'eod-action',status:'partial',dataDate:'2026-10-09',sourceDate:'2026-10-08',orders:{status:'unknown'}};
test('phone EOD cutoff, partial status and missing orders stay distinct from realtime readiness',()=>{const record={info:sandbox.reportInfo(html(model))};assert.equal(record.info.sourceDate,'2026-10-08');assert.equal(record.info.ordersKnown,false);assert.match(sandbox.statusFor(record,'已更新'),/部分更新/);assert.match(sandbox.statusFor(record,'已更新'),/挂单未取得/);assert.ok(!sandbox.statusFor(record,'已更新').includes('实时'));const captured={info:sandbox.reportInfo(html({...model,orders:{status:'ready'}}))};assert.match(sandbox.statusFor(captured,'已更新'),/挂单已独立核实/);assert.match(sandbox.statusFor(captured,'已更新'),/可用资金待核实/);});
test('phone parser rejects an EOD marker with a complete or invalid date claim',()=>{for(const edit of [{status:'ready'},{schemaVersion:5},{sourceDate:'2026-10-09'},{dataDate:'2026-10-08'}])assert.throws(()=>sandbox.reportInfo(html({...model,...edit})));});

test('recorded summary parser retains partial source dates and refuses a false broker or live claim',()=>{
 const legacy={schemaVersion:10,mode:'stored-eod-public-summary',status:'partial',dataDate:'2026-10-09',sourceDate:'2026-10-08',captureStartedAt:'2026-10-09T05:00:40.250Z',captureCompletedAt:'2026-10-09T05:00:53.024Z',risks:{reconciliation:'unknown',liveSource:'not-called'},unknowns:{orders:null,orderReserve:null,planning:null,executableBudget:null,availableFunds:null},concentration:{status:'observed',top1Pct:45,top5Pct:100}};
 for(const summary of [legacy,qualifyRecordedPublicSummary(legacy)]){
  const source=renderPublicEodSummary(summary),info=sandbox.reportInfo(source);
  assert.equal(info.recordedSummary,true);assert.equal(info.sourceDate,'2026-10-08');assert.equal(info.asOfHkt,'13:00');assert.equal(info.ordersKnown,false);assert.match(sandbox.statusFor({info},'已更新'),/未与券商完整核对/);
  for(const edit of [m=>m.status='ready',m=>m.sourceDate='2026-10-09',m=>m.captureCompletedAt='2026-10-10T05:00:00.000Z',m=>m.unknowns.orders=[],m=>m.risks.liveSource='captured',m=>m.schemaVersion=99]){
   const bad=structuredClone(summary);edit(bad);const replacement=source.replace(Buffer.from(JSON.stringify(summary)).toString('base64url'),Buffer.from(JSON.stringify(bad)).toString('base64url'));
   assert.throws(()=>sandbox.reportInfo(replacement));
  }
 }
 const summary=qualifyRecordedPublicSummary(legacy),source=renderPublicEodSummary(summary),bad=structuredClone(summary);bad.concentration.brokerReconciliation='verified';
 assert.throws(()=>sandbox.reportInfo(source.replace(Buffer.from(JSON.stringify(summary)).toString('base64url'),Buffer.from(JSON.stringify(bad)).toString('base64url'))));
});

test('unchanged publication lock accepts the stable loader but rejects actual report markers',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml',import.meta.url),'utf8');
  const guard=workflow.match(/if grep -Eq '([^']+)' "\$proposed_index"/);
  assert.ok(guard,'publication lock must retain its actual-report exclusion');
  const rejectedByLock=text=>{
    const result=spawnSync('grep',['-Eq',guard[1]],{input:text,encoding:'utf8'});
    assert.ok(result.status===0||result.status===1,result.stderr);
    return result.status===0;
  };
  assert.equal(rejectedByLock(page),false,'report parser source is not a variable report');
  const reportMarkers=[html(model),'<!-- xuan-ib-handover:v1 -->','<!--\t xuan-ib-night-action-v1:synthetic -->'];
  for(const marker of reportMarkers){
    assert.equal(rejectedByLock(marker),true,'actual report HTML must stay rejected');
    assert.equal(rejectedByLock(page+'\n'+marker),true,'loader sentinels cannot conceal an appended report');
  }
  assert.equal(sandbox.reportInfo(html(model)).sourceDate,model.sourceDate);
  assert.throws(()=>sandbox.reportInfo(html(model).replace('<!-- xuan-ib-night-action-v1:','<!--  xuan-ib-night-action-v1:')));
  assert.throws(()=>sandbox.reportInfo(html(model)+'\n'+html(model)));
});
