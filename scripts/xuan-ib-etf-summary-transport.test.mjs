import test from 'node:test';
import assert from 'node:assert/strict';
import {TREND_METHOD,simulateEtfTrend,projectOpenEtfTrend} from './xuan-ib-etf-trend.mjs';
import {parseEtfSummary,renderEtfSummaryTemplate,ETF_SUMMARY_OPEN,MAX_ETF_SUMMARY_BYTES} from './xuan-ib-etf-summary-transport.mjs';
const now=new Date('2026-09-04T09:00:00Z');
const data=()=>projectOpenEtfTrend(simulateEtfTrend({methodId:TREND_METHOD,startDate:'2020-09-01',
  frozenDate:'2020-09-04',initialUsd:1000000,reserveUsd:240000,days:[{date:'2020-09-01',actualUsd:1000000,
    actualComplete:true,flowsComplete:true,flows:[],sourceRef:'PRIVATE-SYNTHETIC',quotes:Object.fromEntries(
      ['CSPX','EXUS','EIMI','USSC'].map(s=>[s,{status:'close',usd:10,date:'2020-09-01',source:'synthetic'}]))}]}),{now});
test('canonical public summary round trips without any source or financial input',()=>{
  const summary=data(),text=JSON.stringify(summary);
  assert.deepEqual(parseEtfSummary(text,{now}),summary);
  assert.equal(renderEtfSummaryTemplate(summary,{now}),`${ETF_SUMMARY_OPEN}${text}</template>`);
  assert.ok(!text.includes('PRIVATE-SYNTHETIC'));assert.ok(!text.includes('sourceRef'));
});
test('private result, duplicates, entities, tags, whitespace and oversized transport are rejected',()=>{
  const text=JSON.stringify(data());
  for(const bad of [text.replace('{','{"schemaVersion":3,'),text+' ',text.replace('xuan-etf-open-comparison','<script>'),
    text.replace('xuan-etf-open-comparison','&#120;'),JSON.stringify({...data(),sourceRef:'PRIVATE'}),
    JSON.stringify({...data(),result:{flows:[]}}),' '.repeat(MAX_ETF_SUMMARY_BYTES)])assert.throws(()=>parseEtfSummary(bad,{now}));
});
