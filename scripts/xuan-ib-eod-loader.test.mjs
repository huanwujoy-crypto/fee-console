// Synthetic phone parser fixture; no real report, account or producer evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const page=fs.readFileSync(new URL('../xuan-ib/index.html',import.meta.url),'utf8');
const info=page.slice(page.indexOf('const reportInfo ='),page.indexOf('const requireExactKeys ='));
const status=page.slice(page.indexOf('const statusFor ='),page.indexOf('function updateDecisionControl'));
const sandbox={TextDecoder,Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary'),clock:()=> 'synthetic clock'};
vm.createContext(sandbox);vm.runInContext(info+status+'\nglobalThis.reportInfo=reportInfo;globalThis.statusFor=statusFor;',sandbox);
const html=model=>`<title>XUAN · EOD 行动版</title><!-- xuan-ib-night-action-v1:${Buffer.from(JSON.stringify(model)).toString('base64url')} --><header><p>2026-10-09 · 2026-10-09 13:00 HKT · 数据至 2026-10-08</p></header>`;
const model={schemaVersion:9,mode:'eod-action',status:'partial',dataDate:'2026-10-09',sourceDate:'2026-10-08',orders:{status:'unknown'}};
test('phone EOD cutoff, partial status and missing orders stay distinct from realtime readiness',()=>{const record={info:sandbox.reportInfo(html(model))};assert.equal(record.info.sourceDate,'2026-10-08');assert.equal(record.info.ordersKnown,false);assert.match(sandbox.statusFor(record,'已更新'),/部分更新/);assert.match(sandbox.statusFor(record,'已更新'),/挂单未取得/);assert.ok(!sandbox.statusFor(record,'已更新').includes('实时'));const captured={info:sandbox.reportInfo(html({...model,orders:{status:'ready'}}))};assert.match(sandbox.statusFor(captured,'已更新'),/挂单已独立核实/);assert.match(sandbox.statusFor(captured,'已更新'),/可用资金待核实/);});
test('phone parser rejects an EOD marker with a complete or invalid date claim',()=>{for(const edit of [{status:'ready'},{schemaVersion:5},{sourceDate:'2026-10-09'},{dataDate:'2026-10-08'}])assert.throws(()=>sandbox.reportInfo(html({...model,...edit})));});
