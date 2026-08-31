import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MRVL_T1_SOURCE_SHA = 'fdf1aa6ebb87e56fc5c1a640838e8397bfc68b20';
export const MRVL_T1_SOURCE_BLOB = 'ef5c5be7d078eafd8d4a82f72d0435fa6e7c17eb';
export const MRVL_T1_APPROVAL_ID = 'WU-20260831-MRVL-T1';
export const MRVL_T1_IDENTITY = Object.freeze({ symbol: 'MRVL', portfolioId: '1350094', holdingId: '28987468' });
export const MRVL_T1_COEFFICIENTS = Object.freeze({ low: 0.6, mid: 0.8, high: 1 });
export const MRVL_T1_SNAPSHOT_NOTICE = '本次仅按用户新批准的 MRVL 标准 T1（60% / 80% / 100%）更新旧 2026-08-31 20:55–20:58 HKT 快照的风险口径，未重新取数；原日期、睡前版别、持仓、现金规划与 3 条原始意见回执不变，不证明新的 AM / PM 定时运行成功。';
const policyUrl = new URL('../claude/xuan-ib-ai-tier-overrides-v1.json', import.meta.url);
const aiPattern = /<details><summary>AI 压力敞口[\s\S]*?(?=<details><summary>单票集中度)/g;
const summaryPattern = /<li><b>AI 压力中情景[\s\S]*?<\/li>/g;
const cardPattern = /<details class="dcard" id="D-20260829-MRVL-CLASS"[\s\S]*?<\/details>/g;
const oldMethod = 'AI 压力 T1/T2/T3 阶梯与 ETF 穿透权重逐票沿用（未发明新系数）';
const newMethod = 'AI 压力除 MRVL 按新批准标准 T1 60% / 80% / 100% 纳入外，其余 T1/T2/T3 阶梯与 ETF 穿透权重沿用；中情景按原快照表内输入未舍入汇总，低 / 高仅为原组合近似基数加 MRVL 增量';
const oldExplanation = 'MRVL 待决定事项沿用未决（§0-A 规则本次仍未核实）。';
const newExplanation = 'MRVL 普通资产分类与 §0-C AI 压力分类分开；本次按用户新批准标准 T1 纳入风险测算，原 3 条回执保持历史原文，不代表交易授权。';

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw new Error(`${label}: invalid or unknown fields`);
  }
}

// This is a deliberately narrow approval, not a generic ticker classifier.
// Neither a Sharesight asset label nor a similar ticker grants an AI tier.
export function validateMrvlT1Policy(policy) {
  exactKeys(policy, ['schemaVersion', 'effectiveFromHkt', 'purpose', 'overrides'], 'MRVL policy');
  if (policy.schemaVersion !== 1 || policy.purpose !== 'risk-measurement-only'
      || typeof policy.effectiveFromHkt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(policy.effectiveFromHkt)
      || !Number.isFinite(Date.parse(policy.effectiveFromHkt))
      || !Array.isArray(policy.overrides) || policy.overrides.length !== 1) {
    throw new Error('MRVL policy: invalid scope, effective time or override count');
  }
  const rule = policy.overrides[0];
  exactKeys(rule, ['symbol', 'portfolioId', 'holdingId', 'tier', 'low', 'mid', 'high', 'approvalId'], 'MRVL override');
  for (const [key, value] of Object.entries({ ...MRVL_T1_IDENTITY, tier: 'T1', ...MRVL_T1_COEFFICIENTS, approvalId: MRVL_T1_APPROVAL_ID })) {
    if (rule[key] !== value) throw new Error(`MRVL policy: unapproved ${key}`);
  }
  return Object.freeze({ ...rule });
}

export function loadMrvlT1Policy() {
  const policy = JSON.parse(fs.readFileSync(policyUrl, 'utf8'));
  validateMrvlT1Policy(policy);
  return policy;
}

// Decimal cents, then integer arithmetic: never round each contribution before
// aggregation. Unknown inputs fail rather than turning into a zero exposure.
function usdCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12
      || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    throw new Error('MRVL marketValue must be finite nonnegative USD with at most two decimal places');
  }
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function calculateMrvlT1(input, policy = loadMrvlT1Policy()) {
  const rule = validateMrvlT1Policy(policy);
  exactKeys(input, ['symbol', 'portfolioId', 'holdingId', 'currency', 'marketValue'], 'MRVL holding');
  for (const [key, value] of Object.entries(MRVL_T1_IDENTITY)) {
    if (input[key] !== value) throw new Error(`MRVL holding: unapproved ${key}`);
  }
  if (input.currency !== 'USD') throw new Error('MRVL holding: currency must be USD');
  const cents = usdCents(input.marketValue);
  const contribution = coefficientTenths => Number(cents * BigInt(coefficientTenths)) / 1000;
  return Object.freeze({ ...MRVL_T1_IDENTITY, currency: 'USD', marketValue: input.marketValue, tier: rule.tier,
    approvalId: rule.approvalId, low: contribution(6), mid: contribution(8), high: contribution(10) });
}

function blob(html) {
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');
}
function one(html, pattern) {
  const matches = [...html.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw new Error('MRVL snapshot anchor missing or ambiguous: ' + pattern.source);
  return matches[0][0];
}
function replaceOne(html, search, replacement) {
  const source = typeof search === 'string' ? search : one(html, search);
  if (!source || html.split(source).length !== 2) throw new Error('MRVL snapshot exact anchor missing or ambiguous');
  return html.replace(source, () => replacement);
}
function requireSource(html, binding) {
  exactKeys(binding, ['sourceSha', 'htmlBlob'], 'MRVL source binding');
  if (binding.sourceSha !== MRVL_T1_SOURCE_SHA || binding.htmlBlob !== MRVL_T1_SOURCE_BLOB
      || typeof html !== 'string' || blob(html) !== MRVL_T1_SOURCE_BLOB) {
    throw new Error('MRVL correction requires the exact approved source SHA and report blob; never apply to a newer report');
  }
}
const usd = value => Math.round(value).toLocaleString('en-US');
const pct = (value, denominator) => (100 * value / denominator).toFixed(2);

// Parse only the immutable approved source table. Values are integer USD and
// coefficients have exactly two decimal percent places (basis points). Store
// all products as 1/10000 USD BigInts so sub-cent results are not discarded.
export function calculateMrvlT1Snapshot(html, binding, policy = loadMrvlT1Policy()) {
  requireSource(html, binding);
  validateMrvlT1Policy(policy);
  const ai = one(html, aiPattern);
  const table = one(ai, /<table>[\s\S]*?<\/table>/g);
  const rows = [...table.matchAll(/<tr(?: class="([^"]+)")?>([\s\S]*?)<\/tr>/g)];
  const expected = [['IB-HK 936247', 19], ['Schwab-HK 936249', 7], ['Webull 1350094', 3]];
  let accountIndex = -1;
  const accounts = [];
  const contributions = [];
  let mrvl;
  for (const match of rows) {
    const [, rowClass, contents] = match;
    const cells = [...contents.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (!cells.length) continue;
    if (rowClass === 'tot') continue;
    if (rowClass === 'sec') {
      accountIndex += 1;
      if (!expected[accountIndex] || !cells[0].startsWith(expected[accountIndex][0] + '<span')) throw new Error('Unexpected AI account order');
      accounts.push({ name: expected[accountIndex][0], totalUnits: 0n, count: 0, sourceRow: match[0] });
      continue;
    }
    if (rowClass || accountIndex < 0 || cells.length !== 4) throw new Error('Unexpected AI row structure');
    const symbol = cells[0].match(/<span class="sym">([^<]+)<\/span>/)?.[1];
    if (!symbol || !/^\d{1,3}(?:,\d{3})*$/.test(cells[1])) throw new Error('Invalid source AI market value');
    const marketValue = Number(cells[1].replaceAll(',', ''));
    let coefficient;
    if (symbol === 'MRVL') {
      if (mrvl || accountIndex !== 2 || marketValue !== 21662 || cells[2] !== '—' || cells[3] !== '0') throw new Error('Unexpected source MRVL row');
      mrvl = calculateMrvlT1({ ...MRVL_T1_IDENTITY, currency: 'USD', marketValue }, policy);
      coefficient = 8000;
    } else {
      if (!/^\d{1,3}\.\d{2}%$/.test(cells[2])) throw new Error('Invalid source AI coefficient');
      coefficient = Number(cells[2].replace(/[.%]/g, ''));
      if (coefficient > 10000) throw new Error('Source AI coefficient exceeds 100%');
    }
    const units = BigInt(marketValue) * BigInt(coefficient);
    accounts[accountIndex].count += 1;
    accounts[accountIndex].totalUnits += units;
    contributions.push({ sourceRow: match[0], cells, symbol, accountIndex, marketValue, coefficient, amount: Number(units) / 10000 });
  }
  if (!mrvl || accounts.length !== 3 || accounts.some((account, index) => account.count !== expected[index][1])) throw new Error('Incomplete source AI table');
  const totals = accounts.map(account => Number(account.totalUnits) / 10000);
  if (totals.join('|') !== '1118483.8217|201687.95|73451.55') throw new Error('Source AI calculation differs from approved snapshot');
  const mid = Number(accounts.reduce((sum, account) => sum + account.totalUnits, 0n)) / 10000;
  const denominator = 6141014;
  return { mrvl, accounts: accounts.map(({ totalUnits, ...account }, index) => ({ ...account, amount: totals[index] })), contributions,
    denominator, mid, midPct: pct(mid, denominator),
    lowApprox: 964094 + mrvl.low, highApprox: 1778171 + mrvl.high,
    above20: mid - denominator * .20, headroom25: denominator * .25 - mid, headroom30: denominator * .30 - mid };
}

function normalizeAllowedChanges(html) {
  return html.replace(aiPattern, '').replace(summaryPattern, '').replace(cardPattern, '')
    .replace(oldMethod, '__AI_METHOD__').replace(newMethod, '__AI_METHOD__')
    .replace(oldExplanation, '__MRVL_EXPLANATION__').replace(newExplanation, '__MRVL_EXPLANATION__');
}

export function updateMrvlT1Report(html, binding, policy = loadMrvlT1Policy()) {
  const calculation = calculateMrvlT1Snapshot(html, binding, policy);
  const { mrvl, denominator, mid, midPct, lowApprox, highApprox, above20, headroom25, headroom30 } = calculation;
  const originalAi = one(html, aiPattern);
  let ai = originalAi;
  for (const row of calculation.contributions) {
    const cells = [...row.cells];
    if (row.symbol === 'MRVL') {
      cells[0] = '<span class="sym">MRVL</span><span class="sub"><b>用户已批准标准 T1</b> · 低 / 中 / 高 60% / 80% / 100%</span>';
      cells[2] = '80.00%';
    }
    cells[3] = usd(row.amount);
    ai = replaceOne(ai, row.sourceRow, '<tr>' + cells.map(cell => `<td>${cell}</td>`).join('') + '</tr>');
  }
  for (const account of calculation.accounts) {
    const cells = [...account.sourceRow.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    cells[0] = `${account.name}<span class="sub">分子小计 ${usd(account.amount)}</span>`;
    cells[3] = usd(account.amount);
    ai = replaceOne(ai, account.sourceRow, '<tr class="sec">' + cells.map(cell => `<td>${cell}</td>`).join('') + '</tr>');
  }
  ai = ai.replaceAll('1,376,293', usd(mid)).replaceAll('22.41%', midPct + '%');
  ai = replaceOne(ai, '三账户 · 沿用 v9.11 系数', '三账户 · MRVL 已批准标准 T1');
  ai = replaceOne(ai, '逐票 T1/T2/T3 与 ETF 穿透权重<b>沿用上一版已采用的分类</b>，未发明新系数；ETF holdings as-of 日期同前次披露',
    'MRVL 按用户新批准标准 <b>T1：60% / 80% / 100%</b>；其余逐票分类与 ETF 穿透权重沿用，ETF holdings as-of 日期不变。普通资产类别按 §0-A，AI 压力 tier 按独立 §0-C，不混为一谈');
  ai = replaceOne(ai, '算法沿用上一版：每笔持仓市值 × 中情景系数（阶梯 <b>T1 80% / T2 55% / T3 5%</b>），ETF 按沿用权重逐笔求和 ÷ 分母；市值改用本次 IB / Sharesight 现场读数，系数逐票沿用不变。系数 = 压力情景下预期损失比例，不是「AI 相关度」。',
    '每笔原快照表内市值 × 中情景系数（阶梯 <b>T1 80% / T2 55% / T3 5%</b>），先按未舍入结果汇总，再除以原分母；仅 MRVL 新纳入 T1，其余系数及市值不变。系数是压力情景损失比例，不是「AI 相关度」。各行与账户小计独立四舍五入到美元，显示项相加与合计可差 $1；合计不使用已舍入行值。');
  ai = replaceOne(ai, '<li><b>Webull MRVL $21,662</b> —— §0-A 分类规则本次仍未能核实，比照 MSTR 处理方式不进分子（详见 ⑤）。</li>\n', '');
  ai = replaceOne(ai, /<p style="font-size:12px;margin:5px 0 0"><b>低 \/ 高情景<\/b>[\s\S]*?<\/p>/g,
    `<p style="font-size:12px;margin:5px 0 0"><b>低 / 高情景（近似，非完整逐票三档重算）</b>：保留原组合近似基数 $964,094 / $1,778,171，分别加 MRVL 精确增量 $${mrvl.low.toLocaleString('en-US', { minimumFractionDigits: 2 })} / $${mrvl.high.toLocaleString('en-US', { minimumFractionDigits: 2 })}；低 ≈$${usd(lowApprox)} / <b>${pct(lowApprox, denominator)}%</b>；高 ≈$${usd(highApprox)} / <b>${pct(highApprox, denominator)}%</b>。原组合基数仍为比例近似，不可据此精确判断高情景是否越过警戒线；下列 20% / 25% / 30% 比较均采用中情景。</p>`);
  ai = replaceOne(ai, '（已越 20% 提醒线，+2.41 个百分点）', `（已越 20% 提醒线，+$${usd(above20)} / +${pct(above20, denominator)} 个百分点）`);
  ai = replaceOne(ai, '$158,961 / 2.59 个百分点', `$${usd(headroom25)} / ${pct(headroom25, denominator)} 个百分点`);
  ai = replaceOne(ai, '$466,011 / 7.59 个百分点', `$${usd(headroom30)} / ${pct(headroom30, denominator)} 个百分点`);
  ai = replaceOne(ai, '<span class="k">三级状态</span>', '<span class="k">三级状态（中情景）</span>');
  ai = replaceOne(ai, '<span class="k">距 25% 预警线</span>', '<span class="k">距 25% 预警线（中情景）</span>');
  ai = replaceOne(ai, '<span class="k">距 30% 最高警报线</span>', '<span class="k">距 30% 最高警报线（中情景）</span>');
  ai = replaceOne(ai, 'IB 1,118,483 · Schwab 201,688 · Webull 56,122（不含 MRVL）',
    `IB ${usd(calculation.accounts[0].amount)} · Schwab ${usd(calculation.accounts[1].amount)} · Webull ${usd(calculation.accounts[2].amount)}（含 MRVL）`);
  ai = replaceOne(ai, '<div class="kv"><span class="k">分类敏感度</span><span class="v">MRVL 若计入(T1 80%) → 22.69% ⇒ 日常表述「<b>约 22.4%–22.7%</b>」</span></div>',
    '<div class="kv"><span class="k">MRVL 已批准计入</span><span class="v">$21,662 × 80% = $17,329.60（显示 $17,330）；不再使用未分类排除或敏感度区间作为主读数</span></div>');
  ai = replaceOne(ai, /<div class="kv"><span class="k">对照<\/span>[\s\S]*?<\/div>/g,
    '<div class="kv"><span class="k">同快照口径对照</span><span class="v">旧口径中情景 22.41% → 纳入已批准 MRVL 后 <b>22.69%</b>；变化来自风险口径及汇总精度修正，不是新的市场涨跌或重新取数</span></div>');
  ai = replaceOne(ai, '<div class="kv"><span class="k">性质</span>',
    `<details id="xuan-ib-mrvl-t1-snapshot-update"><summary>本次风险口径更新 <span class="rt">原快照 · 未重新取数</span></summary><div class="dbody"><p>${MRVL_T1_SNAPSHOT_NOTICE}</p></div></details>\n<div class="kv"><span class="k">性质</span>`);
  let output = replaceOne(html, originalAi, ai);
  output = replaceOne(output, summaryPattern,
    `<li><b>AI 压力中情景 ${midPct}%</b>（$${usd(mid)} / $${usd(denominator)}，原快照表内输入未舍入汇总），距 25% 预警线 <b>$${usd(headroom25)} / ${pct(headroom25, denominator)} 个百分点</b>，fail-closed <b>PASS</b>，仍在提醒区间。MRVL $21,662 已按用户批准标准 T1 纳入；仅更新原快照风险口径，未重新取数，不代表新的定时运行。</li>`);
  output = replaceOne(output, cardPattern,
    '<details class="dcard" id="D-20260829-MRVL-CLASS" data-decision-id="D-20260829-MRVL-CLASS" data-decision-status="accepted"><summary>1 · Webull MRVL 标准 T1 风险口径已落实\n' +
    '<span class="rt gv">用户已批准 60% / 80% / 100% · 只调整风险测算</span></summary>\n<div class="dbody">\n' +
    '<p style="margin:5px 0"><b class="lab">事实：</b>普通资产分类「Highly Liquid / 美国科技」与 §0-C AI 压力 tier 是两项规则。现按用户新批准的标准 T1，以原报告 MRVL 市值 $21,662 计入低 / 中 / 高 $12,997.20 / $17,329.60 / $21,662.00，未改变持仓或重新取数。</p>\n' +
    '<p style="margin:5px 0"><b class="lab">落实：</b>本期中情景已纳入 MRVL，并使用未舍入逐票贡献汇总；低 / 高仅增加 MRVL 精确增量，原组合基数仍为近似。未来同一持仓使用已批准 T1 规则和当期核实市值，不复用本期金额。</p>\n' +
    `<p style="margin:5px 0"><b class="lab">状态：</b><b>已决定 / 本期风险计算已更新</b>（<code>accepted</code> 为原回执历史状态，原文保留；不是买卖或转账授权）· 编号 <code>D-20260829-MRVL-CLASS</code> · 新口径批准记录 <code>${MRVL_T1_APPROVAL_ID}</code></p>\n` +
    '</div></details>');
  output = replaceOne(output, oldMethod, newMethod);
  output = replaceOne(output, oldExplanation, newExplanation);
  if (normalizeAllowedChanges(output) !== normalizeAllowedChanges(html)) throw new Error('MRVL correction changed content outside the approved AI presentation scope');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 7 || process.argv[3] !== '--source-sha' || process.argv[5] !== '--html-blob') {
      throw new Error('Usage: node scripts/xuan-ib-mrvl-t1.mjs INPUT.html --source-sha SOURCE_SHA --html-blob HTML_BLOB');
    }
    const html = fs.readFileSync(process.argv[2], 'utf8');
    process.stdout.write(updateMrvlT1Report(html, { sourceSha: process.argv[4], htmlBlob: process.argv[6] }));
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
