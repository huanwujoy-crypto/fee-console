import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificationReportBlob } from './xuan-ib-classification-correction.mjs';
import { renderCashPlan, validateCashPlan } from './xuan-ib-cash-plan.mjs';

export const CASH_CORRECTION_SOURCE_SHA = 'a585bf13a2eb5d2a32f5f074edc91f41749dca3a';
export const CASH_CORRECTION_SOURCE_BLOB = '4987cbb9e1c10a3a5562247784d9fc8a7e575a17';
// Source amounts are bound to the immutable report blob, not a reusable live
// input fixture. Future reports must supply their newly verified USD values.
export const CASH_CORRECTION_INPUT = Object.freeze({ schemaVersion: 1, status: 'snapshot', sourceAsOfHkt: '2026-08-31 16:48–16:55 HKT', equityTotal: 4045136, developed: 455111, emerging: 417160, ibCash: 466322.41, noahCash: 357968.92, reserve: 240000, currency: 'USD', denominator: 'equity-only' });
export const CASH_CORRECTION_NOTICE = '补仓规划更正：按原报告快照重算现金优先方案，未重新取数；持仓、现金、数据时点与原决策回执均不变。';
export const CASH_PRESENTATION_SOURCE_SHA = '12922932bcc89af59c363855f12e86aa48c2c390';
export const CASH_PRESENTATION_SOURCE_BLOB = '2091098e98933e121b9fbdbbfd63771287d9e11c';
export const CASH_PRESENTATION_NOTICE = '展示更新：仅调整代码名称及 USSC 资金安排提示，未重新取数或调整补仓金额。';

function replaceOne(html, pattern, replacement) {
  if ([...html.matchAll(new RegExp(pattern.source, 'g'))].length !== 1) throw new Error('Cash correction anchor missing or ambiguous: ' + pattern.source);
  return html.replace(pattern, () => replacement);
}

// One user-approved display migration. All original bytes outside the two
// cash-plan display blocks and this explanatory notice remain unchanged.
export function updateCashPlanPresentation(html) {
  if (typeof html !== 'string' || classificationReportBlob(html) !== CASH_PRESENTATION_SOURCE_BLOB) throw new Error('Cash presentation requires the exact approved source report blob; do not overwrite a newer report');
  const inputs = [...html.matchAll(/<!-- xuan-ib-cash-plan-v1:([A-Za-z0-9_-]+) -->/g)];
  if (inputs.length !== 1) throw new Error('Cash presentation requires one original input comment');
  const rendered = renderCashPlan(JSON.parse(Buffer.from(inputs[0][1], 'base64url').toString('utf8')));
  if (rendered.template !== inputs[0][0]) throw new Error('Cash presentation must preserve input bytes');
  let output = replaceOne(html, /<div class="kpi" id="xuan-ib-cash-plan-kpi">[\s\S]*?<\/div><\/div>/, rendered.kpi);
  output = replaceOne(output, /<section class="card" id="xuan-ib-cash-plan-detail">[\s\S]*?<\/section>/, rendered.detail);
  output = replaceOne(output, /<li><b>数据与口径。<\/b>/, '<li><b>数据与口径。</b>' + CASH_PRESENTATION_NOTICE);
  const errors = validateCashPlan(output, { previousHtml: html });
  if (errors.length) throw new Error(errors.join('; '));
  return output;
}

export function correctCashPlan(html) {
  if (typeof html !== 'string' || classificationReportBlob(html) !== CASH_CORRECTION_SOURCE_BLOB) throw new Error('Cash correction requires the exact approved source report blob; do not overwrite a newer report');
  const rendered = renderCashPlan(CASH_CORRECTION_INPUT);
  let output = replaceOne(html, /<div class="kpi"><div class="lab">四类 · 补仓缺口合计<\/div>[\s\S]*?<\/div><\/div>/, rendered.kpi);
  output = replaceOne(output, /<div class="pane p3">/, '<div class="pane p3">\n' + rendered.detail);
  output = replaceOne(output, /<div class="kv"><span class="k">动态缺口（纯新钱补入）<\/span>[\s\S]*?<\/div>/,
    '<div class="kv"><span class="k">现金补仓</span><span class="v">见本页上方「现金优先补仓参考」；不把固定分母的静态差额当成现金补足额。</span></div>');
  const usBars = output.match(/<div class="bar"><div class="lbl"><span>美国底仓[\s\S]*?(?=<div class="bar"><div class="lbl"><span>非美发达)/)?.[0];
  if (!usBars) throw new Error('Missing original overweight bars');
  output = output.replace(usBars, '');
  output = replaceOne(output, /<div class="bar"><div class="lbl"><span>USSC 小盘/,
    '<details><summary>超配观察 <span class="rt">暂不计入补仓资金</span></summary><div class="dbody">' + usBars + '</div></details>\n<div class="bar"><div class="lbl"><span>USSC 小盘');
  output = replaceOne(output, /四类「动态缺口」沿用既定 v9\.6 方法学/,
    '四类分类及目标不变；现金补仓采用现金优先联立模型，股票分母随买入增加，预算不足按完整补足额同比例缩减，仅为规划情景');
  output = replaceOne(output, /说明更正：仅更正四桶分类解释，未重新取数或重算金额；原报告数据时点不变。/,
    '四桶分类解释已按历史核验更正；四桶金额未变。' + CASH_CORRECTION_NOTICE);
  output = replaceOne(output, /本次仅更正分类解释，影响范围＝四桶解释文字；原四桶比例、三层流动性及依赖归桶的 KPI 金额均未重算，其余数据与原报告取数时点均保持不变。/,
    '四桶分类解释沿用已更正内容；四桶比例、三层流动性及依赖归桶的金额不变。' + CASH_CORRECTION_NOTICE);
  output = replaceOne(output, /<\/body>/, rendered.template + '\n</body>');
  const protect = [
    /<template id="xuan-ib-decision-state-v1"[^>]*>[\s\S]*?<\/template>/g,
    /<table\b[^>]*>[\s\S]*?<\/table>/g,
    /<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/g,
    /<div class="foot">[\s\S]*?<\/div>/g,
    /<section id="xuan-ib-classification-disclosure-v1">[\s\S]*?<\/section>/g,
    /<details class="dcard"[\s\S]*?<\/details>/g,
  ];
  for (const regex of protect) {
    const before = [...html.matchAll(regex)].map(match => match[0]);
    const after = [...output.matchAll(regex)].map(match => match[0]);
    if (!before.length || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Cash correction changed protected original evidence: ' + regex.source);
  }
  const errors = validateCashPlan(output, { previousHtml: html });
  if (errors.length) throw new Error(errors.join('; '));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const presentation = process.argv[2] === '--ticker-first';
    if (process.argv.length !== (presentation ? 4 : 3)) throw new Error('Usage: node scripts/xuan-ib-cash-plan-correction.mjs [--ticker-first] INPUT.html');
    const source = fs.readFileSync(process.argv[presentation ? 3 : 2], 'utf8');
    process.stdout.write(presentation ? updateCashPlanPresentation(source) : correctCashPlan(source));
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
