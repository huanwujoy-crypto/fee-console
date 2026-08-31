import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClassificationDisclosure, validateClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';

// One historical explanation repair, not a renderer for arbitrary reports.
// A later report must never be overwritten by applying this old correction.
export const CLASSIFICATION_CORRECTION_SOURCE_SHA = '35a09a1302515a3a4a6245d5daf8371d292a91fc';
export const CLASSIFICATION_CORRECTION_SOURCE_BLOB = 'ae0761ca8c1f9adc6822436966767f8a5237c371';
export const CLASSIFICATION_CORRECTION_NOTICE = '说明更正：仅更正四桶分类解释，未重新取数或重算金额；原报告数据时点不变。';

export function classificationReportBlob(html) {
  const bytes = Buffer.from(html, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function replaceOne(html, pattern, replacement, label) {
  const matches = [...html.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw new Error(`Correction anchor must occur exactly once: ${label}`);
  return html.replace(pattern, () => replacement);
}

function protectedParts(html) {
  const state = html.match(/<template\s+id="xuan-ib-decision-state-v1"[^>]*>[\s\S]*?<\/template>/)?.[0];
  const header = html.match(/<div class="hdr">[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  const foot = html.match(/<div class="foot">[\s\S]*?<\/div>/)?.[0];
  // Includes monetary values, percentages and their order throughout the report.
  // Classification row counts are deliberately not financial amounts.
  const financialTokens = html.match(/(?:[+-]?(?:C?\$|USD\s|CAD\s)[\d,]+(?:\.\d+)?(?:[MK])?|[+-]?\d+(?:\.\d+)?%)/g) ?? [];
  const unaffectedCards = ['MRVL-CLASS', 'GOOG-FAMILY-LIMIT'].map(suffix =>
    html.match(new RegExp(`<details class="dcard" id="D-20260829-${suffix}"[\\s\\S]*?<\\/details>`))?.[0]);
  if (!state || !header || !foot || unaffectedCards.some(card => !card)) throw new Error('Protected report evidence is missing');
  return { state, header, foot, financialTokens, unaffectedCards };
}

function assertProtectedParts(original, corrected) {
  const before = protectedParts(original);
  const after = protectedParts(corrected);
  for (const field of Object.keys(before)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) throw new Error(`Correction changed protected report evidence: ${field}`);
  }
  for (const literal of ['2026-08-31 周一 · 临时版 · 数据截至 16:48–16:55 HKT', '2026-08-31 08:48–08:55 UTC（周一 16:48–16:55 HKT）']) {
    if (!original.includes(literal) || !corrected.includes(literal)) throw new Error('Correction changed the original report edition or data time');
  }
}

export function correctClassificationExplanation(html) {
  if (typeof html !== 'string' || classificationReportBlob(html) !== CLASSIFICATION_CORRECTION_SOURCE_BLOB) {
    throw new Error('Refusing correction: input is not the exact approved historical report blob');
  }
  let corrected = replaceOne(html, /<div class="alert">[\s\S]*?<\/div>/,
    '<div class="alert"><b>数据降级：四桶 / 三层流动性</b>继续沿用 2026-08-24 已批准快照，完整核验条件与历史审计证据见「报告说明」。<b>其余数据为原报告 16:48–16:55 HKT 只读实时读数</b>。原报告处于美股盘前时段（LSE/SWX/EBS 已开盘，NYSE/NASDAQ/TSE 尚未开盘），IB 报价为原报告取数时可得最新价格，非 08-31 正式收盘价。<b>' + CLASSIFICATION_CORRECTION_NOTICE + '</b></div>', 'top classification fallback');
  corrected = replaceOne(corrected, /沿用 08-24 · mapping 已核实仍缺 override/,
    '沿用 08-24 · 完整核验仍待完成', 'four-bucket KPI caption');
  corrected = replaceOne(corrected, /私募\/半流动仓位本身零变动/,
    '私募及其他非公开仓位本身零变动', 'non-public positions caption');
  corrected = replaceOne(corrected, /<div class="kv"><span class="k">四桶归类映射<\/span>[\s\S]*?<\/div>/,
    '<div class="kv"><span class="k">四桶归类映射</span><span class="v"><b class="wv">沿用 2026-08-24 已批准快照</b> —— 完整核验条件与历史审计证据统一列于「报告说明」；本次仅更正解释，不更新四桶金额。</span></div>', 'configuration disclosure');
  corrected = replaceOne(corrected, /3 · 四桶 mapping 仍缺多数 Semi Liquid 持仓的 override/,
    '3 · 四桶分类核验与数据完整性复核', 'accepted mapping decision title');
  corrected = replaceOne(corrected, /建议 \(A\) 继续沿用，并尽快 \(C\) 补全 mapping · 已决定 \/ 待落实/,
    '已采纳继续沿用；后续核实现金身份与剩余组合 · 已决定 / 待落实', 'mapping implementation action');
  corrected = replaceOne(corrected, /<p style="margin:5px 0"><b class="lab">事实\/选项：<\/b>本次已重新读取 <code>claude\/four-bucket-mapping\.json<\/code>[\s\S]*?<\/p>/,
    '<p style="margin:5px 0"><b class="lab">事实/选项：</b>原报告对分类覆盖缺口的解释有误，现按已核实的历史审计纠正；证据、范围和沿用条件统一见「报告说明」。本项用户决定与原回执保持不变，继续沿用已批准快照；不以此说明更正宣布家庭全量核验完成或更新四桶金额。</p>', 'mapping decision facts');
  corrected = replaceOne(corrected, /<p style="margin:5px 0"><b class="lab">Claude 意见：<\/b>倾向 <b>\(A\) 继续沿用<\/b>[\s\S]*?<\/p>/,
    '<p style="margin:5px 0"><b class="lab">Claude 意见：</b>落实既有决定：继续沿用已批准快照；下一步先核实现金身份及剩余组合的数据完整性，再完成来源对账与受控核验。不能把历史局部审计视为当前全量结果，不再要求按错误的数量差补建分类。仅推进数据核验，不执行交易。</p>', 'mapping next-step reasoning');
  corrected = replaceOne(corrected, /<li><b>四桶 mapping 与 Semi Liquid 覆盖数再次核实不变<\/b>[\s\S]*?<\/li>/,
    '<li><b>四桶分类说明已更正，金额未重算</b> —— 原覆盖缺口解释不再采用；历史审计及完整核验条件见「报告说明」。继续沿用已批准快照，保留原数据时点与用户意见。<span class="sub">只读观察 · 编号 <code>O-20260831-MAPPING-RECHECK</code></span></li>', 'read-only observation');
  corrected = replaceOne(corrected, /<b>本次降级 \/ 回退<\/b>：四桶 \/ 三层流动性沿用[\s\S]*?(?=<b>计算口径<\/b>)/,
    '<b>本次降级 / 回退</b>：四桶 / 三层流动性沿用 <b>2026-08-24 已批准快照</b>（as-of 2026-08-24）；历史审计、适用范围及沿用条件统一见下方「四桶分类核验与沿用口径」。本次仅更正分类解释，影响范围＝四桶解释文字；原四桶比例、三层流动性及依赖归桶的 KPI 金额均未重算，其余数据与原报告取数时点均保持不变。', 'report notes fallback');
  corrected = replaceOne(corrected, /<\/ol>\s*<\/div><\/details>\s*\n<div class="foot">/,
    `</ol>\n${renderClassificationDisclosure()}\n</div></details>\n\n<div class="foot">`, 'folded report explanation insertion');
  assertProtectedParts(html, corrected);
  const errors = validateClassificationDisclosure(corrected, { previousHtml: html });
  if (errors.length) throw new Error(`Corrected explanation did not validate: ${errors.join('; ')}`);
  return corrected;
}

export function verifyClassificationCorrection(original, corrected) {
  const expected = correctClassificationExplanation(original);
  if (corrected !== expected) throw new Error('Output differs from the deterministic explanation-only correction');
  assertProtectedParts(original, corrected);
  return {
    sourceSha: CLASSIFICATION_CORRECTION_SOURCE_SHA,
    originalHtmlBlob: CLASSIFICATION_CORRECTION_SOURCE_BLOB,
    correctedHtmlBlob: classificationReportBlob(corrected),
    financialTokensPreserved: true,
    originalEditionAndDataTimePreserved: true,
    decisionTemplateAndReceiptsPreserved: true,
    unrelatedDecisionCardsPreserved: true,
    classificationDisclosureValid: true,
    readNewFinancialData: false,
    recalculatedAmounts: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const verify = args[0] === '--verify';
  if ((verify && args.length !== 2) || (!verify && args.length !== 1) || args.at(-1)?.startsWith('--')) {
    process.stderr.write('Usage: node scripts/xuan-ib-classification-correction.mjs [--verify] INPUT.html\n');
    process.exitCode = 2;
  } else {
    try {
      const original = fs.readFileSync(args.at(-1), 'utf8');
      const corrected = correctClassificationExplanation(original);
      process.stdout.write(verify ? `${JSON.stringify(verifyClassificationCorrection(original, corrected))}\n` : corrected);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
