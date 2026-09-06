// Same-snapshot methodology correction. No live data, publication or trading.
import {createHash} from 'node:crypto';
import {calculateAaoiT1} from './xuan-ib-aaoi-t1.mjs';

export const AAOI_SOURCE = Object.freeze({sourceSha:'3bc2f72242fdee745dac8241064e82d79186e14b',htmlBlob:'078ab055e58d3e892370954adc547929dfba68f6'});
export const AAOI_CORRECTION_MARKER = '<!-- xuan-ib-aaoi-snapshot-correction:v1 -->';
export const AAOI_CORRECTED_BLOB = '2ad631bccdf8d3285531c14aef3134124debcf77';
export const AAOI_NOTICE_ID = 'classification:1350094:28656360:WU-20260906-AAOI-T1';
const blob = html => createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');
const usd = value => Math.round(value).toLocaleString('en-US');
const pct = (value, denominator) => (100*value/denominator).toFixed(2);
const fail = message => {throw Error(`AAOI snapshot: ${message}`);};
function one(html, pattern) {
  const matches=[...html.matchAll(new RegExp(pattern.source,'g'))];
  if(matches.length!==1)fail('missing or ambiguous anchor');
  return matches[0][0];
}
function replace(html, source, next) {
  if(!source || html.split(source).length!==2)fail('missing or ambiguous replacement');
  return html.replace(source,()=>next);
}
function requireSource(html,binding) {
  if(binding?.sourceSha!==AAOI_SOURCE.sourceSha||binding?.htmlBlob!==AAOI_SOURCE.htmlBlob||blob(html)!==AAOI_SOURCE.htmlBlob)
    fail('requires exact trusted source pair; never apply to a newer report');
}
const riskPattern=/<section class="card"><h2>AI 压力敞口[\s\S]*?<\/section>/g;
export function requireAaoiCorrectionConfinement(previous,output) {
  const normalize=html=>{
    for(const pattern of [riskPattern,/<li>AI 压力中情景[\s\S]*?<\/li>/g,
      /<div class="kpi"><div class="lab">AI 压力中情景[\s\S]*?<\/div><\/div>/g,
      /<p><b>本期(?:事实更新：|处理结果：)<\/b>(?:Webull AAOI|AAOI)[\s\S]*?<\/p>/g])
      html=replace(html,one(html,pattern),'[APPROVED-RISK-FRAGMENT]');
    return html.replace('<!-- xuan-ib-records-update:v1 -->','').replace(AAOI_CORRECTION_MARKER,'');
  };
  if(normalize(previous)!==normalize(output))fail('changed bytes outside approved risk fragments');
}

export function calculateAaoiSnapshot(html,binding) {
  requireSource(html,binding);
  const risk=one(html,riskPattern);
  if(!html.includes('Webull AAOI 本次读取市值 $10,553.00（100 股，Sharesight 2026-09-05 09:49–09:50 HKT'))fail('dated holding evidence missing');
  const aaoi=calculateAaoiT1({symbol:'AAOI',portfolioId:'1350094',holdingId:'28656360',instrumentId:'523742',currency:'USD',marketValueUsd:10553,valueDate:'2026-09-05'});
  const accounts={'IB-HK':0n,'Schwab-HK':0n,Webull:0n};
  let count=0;
  for(const row of risk.matchAll(/<tr><td>((IB-HK|Schwab-HK|Webull) [^<]+)<\/td><td>([\d,]+)<\/td><td>(\d+\.\d{2})%<\/td><td>[\d,]+<\/td><\/tr>/g)){
    const value=BigInt(row[3].replaceAll(',','')),bps=BigInt(row[4].replace('.',''));
    if(bps>10000n||/\bAAOI\b/.test(row[1]))fail('invalid base exposure');
    accounts[row[2]]+=value*bps;count++;
  }
  if(count!==29 || Object.values(accounts).reduce((a,b)=>a+b,0n)!==13485153802n)fail('base table differs');
  accounts.Webull+=84424000n;
  const mid=Number(Object.values(accounts).reduce((a,b)=>a+b,0n))/10000;
  const denominator=6198031.57;
  return {aaoi,mid,denominator,midPct:pct(mid,denominator),accounts:Object.fromEntries(Object.entries(accounts).map(([k,v])=>[k,Number(v)/10000])),
    lowApprox:1004333+aaoi.low,highApprox:1845236+aaoi.high,above20:mid-denominator*.2,headroom25:denominator*.25-mid,headroom30:denominator*.3-mid};
}

export function updateAaoiSnapshot(html,binding) {
  const c=calculateAaoiSnapshot(html,binding),old=one(html,riskPattern);
  let risk=old;
  risk=replace(risk,'三账户 · MRVL 已批准标准 T1','三账户 · MRVL / AAOI 标准 T1');
  risk=replace(risk,one(risk,/<p>分账户分子（中）[\s\S]*?<\/p>/g),
    `<p>分账户分子（中）：IB ${usd(c.accounts['IB-HK'])} · Schwab ${usd(c.accounts['Schwab-HK'])} · Webull ${usd(c.accounts.Webull)}（含 MRVL 和 AAOI）。已越 20% 提醒线 +$${usd(c.above20)} / +${pct(c.above20,c.denominator)} 个百分点；距 25% 预警线 $${usd(c.headroom25)} / ${pct(c.headroom25,c.denominator)} 个百分点；距 30% 最高警报线 $${usd(c.headroom30)} / ${pct(c.headroom30,c.denominator)} 个百分点。</p>`);
  risk=replace(risk,one(risk,/<p>低 \/ 高情景[\s\S]*?<\/p>/g),
    `<p>低 / 高情景（近似，未作完整逐票重算）：沿用原低 / 高近似值 $1,004,333 / $1,845,236，再加 AAOI 精确贡献 $6,331.80 / $10,553.00；低 ≈$${usd(c.lowApprox)} / 约 ${pct(c.lowApprox,c.denominator)}%；高 ≈$${usd(c.highApprox)} / 约 ${pct(c.highApprox,c.denominator)}%，不作精确 30% 判断。</p>`);
  const total='<tr><td>分子合计（未舍入汇总）';
  risk=replace(risk,total,`<tr><td>Webull AAOI 标准 T1</td><td>10,553</td><td>80.00%</td><td>8,442</td></tr>${total}`);
  risk=risk.replaceAll('21.76%',c.midPct+'%').replaceAll('1,348,514',usd(c.mid));
  risk=replace(risk,'</h2>', '</h2><p class="sub">同快照口径更新 · 未重新取数</p>');
  risk=replace(risk,'</section>',`<details id="xuan-aaoi-applied"><summary>AAOI 分类与计算记录</summary><p>AAOI 已按 T1 纳入；低 / 中 / 高贡献为 $6,331.80 / $8,442.40 / $10,553.00。负责人：Codex。仅风险计量，不执行交易。</p><p>使用原报告 2026-09-05 09:49–09:50 HKT 同一快照及三账户分母。中情景按原表内已展示市值与系数重新求和，先汇总后舍入；与原分子显示值相差约 $1.38，来自原行值的展示精度，不是新行情。低高基数仍为近似。此次只修正风险口径，不代表新的上午或睡前运行。</p></details></section>`);
  let output=replace(html,old,risk);
  const summary=one(html,/<li>AI 压力中情景[\s\S]*?<\/li>/g);
  output=replace(output,summary,`<li>AI 压力中情景 ${c.midPct}%（$${usd(c.mid)} / $6,198,032），AAOI 已计入 T1；高于 20% 提醒线 $${usd(c.above20)}，距 25% 预警线 $${usd(c.headroom25)} / ${pct(c.headroom25,c.denominator)} 个百分点；提醒区间不变。此次为原快照口径更新，GOOG 三账户仍为 4.25%。</li>`);
  const kpi=one(html,/<div class="kpi"><div class="lab">AI 压力中情景[\s\S]*?<\/div><\/div>/g);
  output=replace(output,kpi,kpi.replaceAll('21.76%',c.midPct+'%').replaceAll('1,348,514',usd(c.mid)).replace('· fail-closed PASS','· AAOI 已计入 T1'));
  const current=one(output,/<p><b>本期事实更新：<\/b>Webull AAOI[\s\S]*?<\/p>/g);
  output=replace(output,current,'<p><b>本期处理结果：</b>AAOI 已按获准的 T1（60% / 80% / 100%）计入同快照风险计算。无需再次确认；负责人为 Codex。下列建议和回执仅为历史记录，不表示仍待落实。</p>');
  // Immutable decision/receipt templates, other financial sections and dates
  // remain exact. Publication is a separate protected operation.
  output=replace(output,'<!-- xuan-ib-records-update:v1 -->','');
  output=replace(output,'<!-- xuan-ib-handover:v1 -->','<!-- xuan-ib-handover:v1 -->'+AAOI_CORRECTION_MARKER);
  requireAaoiCorrectionConfinement(html,output);
  if(blob(output)!==AAOI_CORRECTED_BLOB)fail('transform output differs from approved correction digest');
  return output;
}

export function verifyAaoiSnapshotCorrection(html,previousHtml,binding) {
  const marked=/xuan-ib-aaoi-snapshot-correction/i.test(html);
  if(!marked)return false;
  if(typeof previousHtml==='string')requireAaoiCorrectionConfinement(previousHtml,html);
  if(typeof previousHtml!=='string'||html!==updateAaoiSnapshot(previousHtml,binding))fail('correction is not the exact deterministic result');
  return true;
}
