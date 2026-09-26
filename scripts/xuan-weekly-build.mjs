// Private weekly artifact. No broker writes and no public publication.
import fs from 'node:fs';
import {buildWeeklyAbc} from './xuan-weekly-abc.mjs';
import {buildAiRiskInputFromCapture} from './xuan-ib-ai-risk-input.mjs';
import {buildAiTierCoverage} from './xuan-ib-ai-tier-coverage.mjs';
import {computeAiPressure} from './xuan-ib-ai-pressure.mjs';
import {familyOrdinaryConcentrations} from './xuan-ib-single-stock-concentration.mjs';
import {fingerprint} from './xuan-ib-run-manifest.mjs';

const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:0});
export function build(input){
  const abc=buildWeeklyAbc(input.abc);
  if(abc.result.stop)throw Error('abc_stopped_'+abc.result.stop.date);
  for(const receipt of input.sharesight)receipt.rawFingerprint=fingerprint(receipt.raw);
  const previousTrustedHtml=input.previousRecords
    ?`<template id="xuan-ib-ai-tier-records-v1" type="application/json">${JSON.stringify(input.previousRecords).replace(/</g,'\\u003c')}</template>`:null;
  const registry=JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json',import.meta.url),'utf8'));
  const envelope=buildAiRiskInputFromCapture(input,{previousTrustedHtml,registry});
  if(envelope.provenance.some(p=>p.reportCutoffDate!==input.riskCutoff))throw Error('risk_cutoff_mismatch');
  const coverage=buildAiTierCoverage(envelope.riskConstituents);
  const pressure=computeAiPressure(envelope.riskConstituents,coverage,{denominator:envelope.riskDenominator});
  const concentration=familyOrdinaryConcentrations(pressure.rows,pressure.denominatorCents);
  const end=abc.result.rows.at(-1);
  const groups=new Map();
  for(const row of pressure.rows.filter(r=>r.status==='classified')){
    const coefficient=row.coefficients.mid;
    const list=groups.get(coefficient)||[];list.push(row);groups.set(coefficient,list);
  }
  const rowHtml=row=>`<div class="line"><span>${esc(row.symbol)} <small>${esc(row.custodian)}</small></span><b>$${usd(Number(row.contributionCents)/100)}</b></div>`;
  const ai=[...groups].sort((a,b)=>b[0]-a[0]).map(([c,rows])=>{
    rows.sort((a,b)=>Number(b.contributionCents)-Number(a.contributionCents));
    return `<h3>系数 ${(c*100).toFixed(0)}%</h3>${rows.slice(0,3).map(rowHtml).join('')}${rows.length>3?`<details><summary>其余 ${rows.length-3} 项</summary>${rows.slice(3).map(rowHtml).join('')}</details>`:''}`;
  }).join('');
  const names={A:'A · IB 实际',B:'B · 四 ETF',C:'C · CSPX'};
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 周末记录</title>
  <style>body{font:17px system-ui;margin:0;background:#f3f6f7;color:#152129}main{max-width:760px;margin:auto;padding:20px}h1{font-size:25px}h2{font-size:21px}h3{font-size:16px;color:#53616a;margin:22px 0 5px}.muted,small,summary{color:#64737c}section{background:white;border:1px solid #e0e5e8;border-radius:18px;padding:20px;margin:18px 0}.line{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #edf0f2}.line span{min-width:0}.line b{text-align:right;white-space:nowrap}.big{font-size:32px;font-weight:750}summary{padding:12px 0;cursor:pointer}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:right}.row3>:first-child{text-align:left}nav a{color:#225b69;margin-right:20px}p{line-height:1.6}small{font-size:13px}</style>
  <style>.row3.line{display:grid;grid-template-columns:1fr 1fr 1fr}@media(max-width:420px){main{padding:12px}section{padding:14px}.row3{font-size:14px;gap:5px}.row3.line{gap:5px}}</style>
  <main><h1>XUAN · 周末记录</h1><p class="muted">风险 ${esc(input.riskCutoff)} · ABC ${esc(input.abc.cutoff)}${input.riskCutoff!==input.abc.cutoff?' · 行情待补齐':' · 已完成'}</p><nav><a href="#risk">风险</a><a href="#abc">ABC 比较</a></nav>
  <section id="risk"><h2>AI 压力 · 中情景</h2><div class="big">${(pressure.ratio*100).toFixed(2)}%</div><p class="muted">IB、嘉信及 Webull · 压力金额排序</p>${ai}<details><summary>说明</summary><p>采用现有已批准系数。分母含三账户现金；低、高情景系数未齐，不作推算。此指标不是预测亏损。来源为 Sharesight 已记录数据。</p><p>未纳入 AI 敞口：${pressure.rows.filter(r=>r.status==='excluded').map(r=>esc(r.symbol)).join('、')}</p></details></section>
  <section><h2>单票集中度</h2><p class="muted">三账户合计 · 超过 1% · 不含 BRK.B</p>${concentration.map(r=>`<div class="line"><span>${esc(r.label)}</span><b>${r.percent.toFixed(2)}%</b></div>`).join('')||'<p>没有超过 1% 的单票</p>'}</section>
  <section id="abc"><h2>ABC · 同资金路径</h2><p class="muted">2026-08-01 起 · IB 单账户</p><div class="row3 muted"><span>方案</span><span>累计表现</span><span>期末金额</span></div>${['A','B','C'].map(k=>`<div class="row3 line"><span>${names[k]}</span><b>${(end.index[k]-100).toFixed(2)}%</b><b>$${usd(end.endingUsd[k])}</b></div>`).join('')}<details><summary>计算说明</summary><p>以 7 月 31 日收盘为期初。仅计 IB，不加 NOAH，不扣待 CALL。现金及证券转仓按 IB 记录作同日同额调整；采用日终近似，非结算结果。</p><p>B：CSPX 60%、EXUS 23%、EIMI 12%、USSC 5%；C：CSPX 100%。不每日再平衡。B/C 为事后模拟，行情采用 USD 日收盘价。</p></details></section><p class="muted">私密记录 · 不下单、不转账</p></main></html>`;
  return {html,abc,pressure,records:coverage.entries,diagnostics:envelope.diagnostics,
    receipt:{complete:true,cutoff:input.abc.cutoff,abcRows:abc.result.rows.length,riskRows:pressure.rows.length,
      riskMidAvailable:pressure.scenarios.mid.available,previousManifest:envelope.previousManifest}};
}
if(process.argv[1]?.endsWith('xuan-weekly-build.mjs')){
  try{process.stdout.write(JSON.stringify(build(JSON.parse(fs.readFileSync(0,'utf8')))));}
  catch(e){process.stderr.write(JSON.stringify({code:e.code||e.message}));process.exitCode=1;}
}
