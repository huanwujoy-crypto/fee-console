import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {AAOI_SOURCE,AAOI_CORRECTION_MARKER,calculateAaoiSnapshot,updateAaoiSnapshot,verifyAaoiSnapshotCorrection} from './xuan-ib-aaoi-snapshot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const original=execFileSync('git',['show','54b65b04fad0facaad9d5a5370844f68464da53f:xuan-ib/latest.html'],{cwd:root,encoding:'utf8'});
const output=updateAaoiSnapshot(original,AAOI_SOURCE);
test('same dated AAOI input added once to matching scope without double counting denominator',()=>{
  const c=calculateAaoiSnapshot(original,AAOI_SOURCE);
  assert.equal(c.mid,1356957.7802);assert.equal(c.midPct,'21.89');assert.equal(c.denominator,6198031.57);
  assert.deepEqual([c.aaoi.low,c.aaoi.mid,c.aaoi.high],[6331.8,8442.4,10553]);
  assert.equal(c.accounts.Webull,118979.95);
  assert.equal(verifyAaoiSnapshotCorrection(output,original,AAOI_SOURCE),true);
  assert.throws(()=>updateAaoiSnapshot(output,AAOI_SOURCE));
});
test('correction preserves all inert templates, non-risk panes, dates and independent cash values',()=>{
  const templates=h=>[...h.matchAll(/<template\b[^>]*>[\s\S]*?<\/template>/g)].map(m=>m[0]);
  assert.deepEqual(templates(output),templates(original));
  for(const id of ['p1','p3','p5']){
    const pattern=new RegExp(`<div class="pane ${id}">[\\s\\S]*?(?=<div class="pane|<details class="card" id="report-notes|<footer)`);
    assert.equal(output.match(pattern)?.[0],original.match(pattern)?.[0]);
  }
  assert.equal(output.match(/<span class="date">[^<]+/)[0],original.match(/<span class="date">[^<]+/)[0]);
  assert.match(output,/低 \/ 高情景（近似/);assert.match(output,/不作精确 30% 判断/);
  assert.match(output,/21\.89%/);assert.match(output,/原快照口径更新/);
});
test('missing marker, duplicate marker, wrong source, altered amounts or extra payload cannot authorize a correction',()=>{
  assert.equal(verifyAaoiSnapshotCorrection(original,original,AAOI_SOURCE),false);
  for(const candidate of [output.replace('21.89%','1.00%'),output+' ',output.replace(AAOI_CORRECTION_MARKER,AAOI_CORRECTION_MARKER.repeat(2)),output.replace('$754,755','$999,999')])
    assert.throws(()=>verifyAaoiSnapshotCorrection(candidate,original,AAOI_SOURCE));
  assert.throws(()=>verifyAaoiSnapshotCorrection(output,original,{...AAOI_SOURCE,sourceSha:'a'.repeat(40)}));
  assert.throws(()=>verifyAaoiSnapshotCorrection(output,original+' ',AAOI_SOURCE));
});
test('trusted guard accepts exact historical correction only and rejects tampered scope',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aaoi-guard-'));
  try{
    const previous=path.join(dir,'previous.html'),candidate=path.join(dir,'candidate.html');
    fs.writeFileSync(previous,original);
    for(const [html,pass] of [[output,true],[output.replace('21.89%','1.00%'),false],[output.replace('6,198,031.57','7,198,031.57'),false]]){
      fs.writeFileSync(candidate,html);
      const result=spawnSync(process.execPath,['scripts/handover-guard.mjs',candidate,'2026-09-05',previous],{cwd:root,encoding:'utf8',env:{...process.env,XUAN_IB_PREVIOUS_SOURCE_SHA:AAOI_SOURCE.sourceSha,XUAN_IB_PREVIOUS_HTML_BLOB:AAOI_SOURCE.htmlBlob}});
      assert.equal(result.status===0,pass,result.stderr+result.stdout);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
