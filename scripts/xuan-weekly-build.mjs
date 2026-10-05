// Private weekly artifact. No broker writes and no public publication.
import fs from 'node:fs';
import {buildWeeklyAbc} from './xuan-weekly-abc.mjs';
import {buildWeeklyAudit,renderWeeklyAudit} from './xuan-weekly-audit.mjs';
import {buildAiRiskInputFromCapture} from './xuan-ib-ai-risk-input.mjs';
import {buildAiExposure} from './xuan-weekly-ai-exposure.mjs';
import {loadPrivateAiPolicy,readPrivateManifest} from './xuan-weekly-private-ai-snapshots.mjs';
import {buildAiDualExposure,renderAiDualExposure} from './xuan-weekly-ai-dual-exposure.mjs';
import {buildAiReviewPriority,renderAiReviewPriority} from './xuan-weekly-ai-review-priority.mjs';
import {buildWeeklyConcentration,renderWeeklyConcentration} from './xuan-weekly-concentration.mjs';
import {fingerprint} from './xuan-ib-run-manifest.mjs';

const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:0});
export function build(input){
  const abc=buildWeeklyAbc(input.abc);
  if(abc.result.stop)throw Error('abc_stopped_'+abc.result.stop.date);
  const audit=buildWeeklyAudit(input.abc,abc);
  for(const receipt of input.sharesight)receipt.rawFingerprint=fingerprint(receipt.raw);
  const previousTrustedHtml=input.previousRecords
    ?`<template id="xuan-ib-ai-tier-records-v1" type="application/json">${JSON.stringify(input.previousRecords).replace(/</g,'\\u003c')}</template>`:null;
  const registry=JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json',import.meta.url),'utf8'));
  const envelope=buildAiRiskInputFromCapture(input,{previousTrustedHtml,registry});
  if(envelope.provenance.some(p=>p.reportCutoffDate!==input.riskCutoff))throw Error('risk_cutoff_mismatch');
  const privateEvidence=loadPrivateAiPolicy({cutoff:input.riskCutoff,directory:process.env.XUAN_WEEKLY_PRIVATE_SNAPSHOT_DIR,manifest:readPrivateManifest(process.env.XUAN_WEEKLY_PRIVATE_MANIFEST_PATH)});
  const policy=privateEvidence.policy;
  const aiExposure=buildAiExposure(envelope,{cutoff:input.riskCutoff,policy,previous:input.previousExposure});
  const aiDualExposure=buildAiDualExposure(envelope,{cutoff:input.riskCutoff,actualAllocation:aiExposure,policy,previous:input.previousAiDualExposure});
  const aiReviewPriority=buildAiReviewPriority(envelope,{cutoff:input.riskCutoff,actualAllocation:aiExposure,policy});
  const concentration=buildWeeklyConcentration(envelope,{cutoff:input.riskCutoff});
  const records=envelope.riskConstituents.map(r=>({key:r.portfolioId+':'+r.holdingId,symbol:r.symbol,custodian:r.custodian,status:'observed',namespace:'WEEKLY'}));
  const end=abc.result.rows.at(-1);
  const ai=renderAiDualExposure(aiExposure,aiDualExposure)+renderAiReviewPriority(aiReviewPriority);
  const names={A:'A · IB 实际',B:'B · 四 ETF',C:'C · CSPX'};
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 周末记录</title>
  <style>body{font:17px system-ui;margin:0;background:#f3f6f7;color:#152129}main{max-width:760px;margin:auto;padding:20px}h1{font-size:25px}h2{font-size:21px}h3{font-size:16px;color:#53616a;margin:22px 0 5px}.muted,small,summary{color:#64737c}section{background:white;border:1px solid #e0e5e8;border-radius:18px;padding:20px;margin:18px 0}.line{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #edf0f2}.line span{min-width:0}.line b{text-align:right;white-space:nowrap}.big{font-size:32px;font-weight:750}summary{padding:12px 0;cursor:pointer}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:right}.row3>:first-child{text-align:left}nav a{color:#225b69;margin-right:20px}p{line-height:1.6}small{font-size:13px}</style>
  <style>.row3.line{display:grid;grid-template-columns:1fr 1fr 1fr}@media(max-width:420px){main{padding:12px}section{padding:14px}.row3{font-size:14px;gap:5px}.row3.line{gap:5px}}</style>
  <main><h1>XUAN · 周末记录</h1><p class="muted">风险 ${esc(input.riskCutoff)} · ABC ${esc(input.abc.cutoff)}${input.riskCutoff!==input.abc.cutoff?' · 行情待补齐':' · 已完成'}</p><nav><a href="#risk">风险</a><a href="#concentration">单票集中度</a><a href="#abc">ABC 比较</a></nav>
  <section id="risk">${ai}</section>
  <section id="concentration">${renderWeeklyConcentration(concentration)}</section>
  <section id="abc"><h2>ABC · 同资金路径</h2><p class="muted">2026-08-01 起 · IB 单账户</p><div class="row3 muted"><span>方案</span><span>累计表现</span><span>期末金额</span></div>${['A','B','C'].map(k=>`<div class="row3 line"><span>${names[k]}</span><b>${(end.index[k]-100).toFixed(2)}%</b><b>$${usd(end.endingUsd[k])}</b></div>`).join('')}<details><summary>计算说明</summary><p>以 7 月 31 日收盘为期初。仅计 IB，不加 NOAH，不扣待 CALL。现金及证券转仓按 IB 记录作同日同额调整；采用日终近似，非结算结果。</p><p>B：CSPX 60%、EXUS 23%、EIMI 12%、USSC 5%；C：CSPX 100%。不每日再平衡。B/C 为事后模拟，行情采用 USD 日收盘价。</p></details></section><p class="muted">私密记录 · 不下单、不转账</p></main></html>`;
  const displayHtml=html.replace('累计表现','累计 TWR')
    .replace('<style>','<style>.ai-category{border-top:1px solid #e0e5e8;margin-top:18px;padding-top:2px}.ai-category p{margin:6px 0}.ai-coverage{background:#f6f7f8;border-radius:10px;padding:12px;font-size:14px}.line span{overflow-wrap:anywhere}.audit-scroll{overflow-x:auto}.audit-table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}.audit-table th,.audit-table td{text-align:right;white-space:nowrap;padding:9px 8px;border-bottom:1px solid #edf0f2}.audit-table th:first-child,.audit-table td:first-child{text-align:left}')
    .replace('<details><summary>计算说明</summary>',`${renderWeeklyAudit(audit)}<details><summary>计算说明</summary>`)
    .replace('采用日终近似，非结算结果。','剔除入出金影响，交易成本已计入。逐日收益＝（当日资产－当日净流入）÷前日资产－1，再逐日连乘；与管理费的组合毛 TWR 使用相同的日终现金流调整方法。用于比较管理表现，非结算结果。')
    .replace('不每日再平衡。B/C 为事后模拟，行情采用 USD 日收盘价。','不每日再平衡。B/C 为事后模拟，采用 ETF 美元收盘价，不另估佣金、个人税费及现金利息；A 保留 IB 实际成本，不另扣模拟管理费。用户已确认 IB 未实扣管理费或业绩提成。比较需兼顾风险和观察期长短。</p><p>B/C 四只 ETF 均为累积型（Accumulating）：基金内部税后分红再投资已反映在价格中，不重复加分红，也不再扣一次 15%。15% 是用户指定的现金派息模拟税率，不是所有底层市场的统一税率；当前无独立派息可再次计税。若以后改用派息型，须另核对现金分红、扣税及再投资，不能直接沿用此价格口径。');
  return {html:displayHtml,abc,audit,aiExposure,aiDualExposure,aiReviewPriority,concentration,records,diagnostics:{...(envelope.diagnostics||{}),privateAiSources:privateEvidence.observations},
    receipt:{complete:true,cutoff:input.abc.cutoff,abcRows:abc.result.rows.length,riskRows:aiExposure.rows.length,
      aiMethodId:aiExposure.methodId,aiPrimaryMethodId:aiDualExposure.methodId,aiReviewMethodId:aiReviewPriority.methodId,aiCoverageComplete:aiExposure.coverageComplete,
      concentrationMethodId:concentration.methodId,concentrationIssuers:concentration.rows.length,
      concentrationEtfSources:concentration.matchedFunds.length,concentrationEtfMissing:concentration.missingFunds.length,
      previousManifest:envelope.previousManifest}};
}
if(process.argv[1]?.endsWith('xuan-weekly-build.mjs')){
  try{process.stdout.write(JSON.stringify(build(JSON.parse(fs.readFileSync(0,'utf8')))));}
  catch(e){process.stderr.write(JSON.stringify({code:e.code||e.message}));process.exitCode=1;}
}
