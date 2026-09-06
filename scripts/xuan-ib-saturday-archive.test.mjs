import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildSaturdayArchive} from './xuan-ib-saturday-archive.mjs';
const repo=new URL('../',import.meta.url);
const {html,audit}=buildSaturdayArchive();
const source=execFileSync('git',['show','65c846f:xuan-ib/latest.html'],{cwd:repo,encoding:'utf8'});
test('published historical artifact is deterministic and source-blob pinned',()=>{
 assert.equal(html,fs.readFileSync(new URL('xuan-ib/history/2026-09-05-am.html',repo),'utf8'));
 assert.equal(audit.sourceBlob,'eec28a0694dcebdb3ca7790b592ceee38a0e4fa2');
 assert.deepEqual([audit.holdings,audit.orders,audit.receipts,audit.newFinancialReads],[26,9,3,0]);
 assert.equal(buildSaturdayArchive().html,html);
});
test('historical view cannot impersonate new published report or submit actions',()=>{
 assert.doesNotMatch(html,/<script|<form|<button|shortcuts:\/\/|<!-- xuan-ib-handover:v1 -->/i);
 assert.match(html,/历史版 · 09-05 上午数据，非今日行情/);
 assert.match(html,/href="\.\.\/">返回最新版/);
 assert.match(html,/sandbox=""/);
 assert.match(html,/这里只读，不提交回应/);
});
test('history preserves immutable state and ETF open summary',()=>{
 for(const id of ['xuan-ib-decision-state-v1','xuan-etf-open-summary-v3']){
  const original=source.match(new RegExp(`<template id="${id}"[\\s\\S]*?<\\/template>`))?.[0];
  if(original)assert.ok(html.includes(original),id);
 }
 assert.ok(html.includes(source.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')));
});
test('compact display includes all requested acceptance sections',()=>{
 assert.match(html,/white-space:nowrap/);
 assert.match(html,/买入 <small>6 张/);
 assert.match(html,/卖出 <small>3 张/);
 assert.match(html,/brief-signal attention/);
 assert.match(html,/<summary>使用指南/);
 assert.match(html,/其它持仓（/);
 assert.match(html,/详细说明/);
 assert.match(html,/原报告全文/);
 assert.match(html,/ABC 表现比较/);
 assert.match(html,/2026-09-01 收盘起算 · 数据至 2026-09-03/);
 assert.match(html,/常青基金/);
 assert.match(html,/<summary>⑥ 挂单提醒/);
 assert.ok(html.indexOf('ABC 表现比较')<html.indexOf('原方案与历史基线记录'));
});
