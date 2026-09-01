import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_ID = 'xuan-ib-index-etf-policy-v2';

const TOP_KEYS = ['schemaVersion', 'policyId', 'status', 'approvedDate', 'mode', 'scope', 'allocation', 'funding', 'callReserve', 'benchmark', 'products', 'controls'];
const PRODUCT_ROLES = ['us-large-cap-core', 'ai-growth-tilt', 'us-small-value', 'developed-ex-us', 'emerging-markets', 'call-reserve-candidate'];
const PRODUCT_TICKERS = ['CSPX', 'EQAC', 'USSC', 'EXUS', 'EIMI', 'IB01'];
const PRODUCT_ISINS = ['IE00B5BMR087', 'IE00BFZXGZ54', 'IE00BSPLC413', 'IE0006WW1TQ4', 'IE00BKM4GZ66', 'IE00BGSF1X88'];
const PRODUCT_VENUES = ['LSE', 'SWX', 'LSE', 'LSE', 'LSE', 'LSE'];
const BENCHMARK_METRICS = ['after-tax-return', 'max-drawdown', 'ai-participation', 'us-situs-share', 'call-coverage'];
const ROLE_LABELS = {
  'us-large-cap-core': '美国大盘核心',
  'ai-growth-tilt': 'AI／成长倾斜',
  'us-small-value': '美国小盘价值',
  'developed-ex-us': '非美发达',
  'emerging-markets': '新兴市场',
  'call-reserve-candidate': 'CALL 备用金候选',
};
const METRIC_LABELS = {
  'after-tax-return': '税后收益',
  'max-drawdown': '最大回撤',
  'ai-participation': 'AI 参与',
  'us-situs-share': 'US-situs 占比',
  'call-coverage': 'CALL 覆盖',
};

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new Error(`${name} has an invalid schema`);
}

function equalNumber(actual, expected, name) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12) throw new Error(`${name} must equal ${expected}`);
}

export function validatePolicy(policy) {
  exactKeys(policy, TOP_KEYS, 'policy');
  if (policy.schemaVersion !== 2 || policy.policyId !== POLICY_ID) throw new Error('policy identity is invalid');
  if (policy.status !== 'approved-not-implemented' || policy.mode !== 'read-only-planning') throw new Error('policy must remain approved but not implemented and read-only');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy.approvedDate)) throw new Error('approvedDate is invalid');

  exactKeys(policy.scope, ['fundingSources', 'eligibleAssets', 'themeExclusions'], 'scope');
  if (JSON.stringify(policy.scope.fundingSources) !== JSON.stringify(['IB-HK all assets', 'NOAH-HK cash excluding theme investments'])
      || policy.scope.eligibleAssets !== 'equity-index-etf-only'
      || JSON.stringify(policy.scope.themeExclusions) !== JSON.stringify(['GLD', 'SLV', 'MSTR', 'HODL'])) throw new Error('scope differs from the approval');

  exactKeys(policy.allocation, ['total', 'us'], 'allocation');
  exactKeys(policy.allocation.total, ['us', 'developedExUs', 'emergingMarkets'], 'allocation.total');
  equalNumber(policy.allocation.total.us, .65, 'US target');
  equalNumber(policy.allocation.total.developedExUs, .23, 'developed ex-US target');
  equalNumber(policy.allocation.total.emergingMarkets, .12, 'emerging-markets target');
  equalNumber(Object.values(policy.allocation.total).reduce((sum, value) => sum + value, 0), 1, 'total target');

  exactKeys(policy.allocation.us, ['smallValue', 'aiGrowthTilt', 'largeCapCore'], 'allocation.us');
  equalNumber(policy.allocation.us.smallValue, .05, 'US small-value target');
  exactKeys(policy.allocation.us.aiGrowthTilt, ['minimum', 'initialAfterValidation', 'maximum'], 'allocation.us.aiGrowthTilt');
  equalNumber(policy.allocation.us.aiGrowthTilt.minimum, 0, 'AI tilt minimum');
  equalNumber(policy.allocation.us.aiGrowthTilt.initialAfterValidation, .08, 'AI tilt initial value');
  equalNumber(policy.allocation.us.aiGrowthTilt.maximum, .08, 'AI tilt maximum');
  exactKeys(policy.allocation.us.largeCapCore, ['formula', 'minimum', 'maximum'], 'allocation.us.largeCapCore');
  if (policy.allocation.us.largeCapCore.formula !== '0.60 - aiGrowthTilt') throw new Error('US core formula differs from the approval');
  equalNumber(policy.allocation.us.largeCapCore.minimum, .52, 'US core minimum');
  equalNumber(policy.allocation.us.largeCapCore.maximum, .60, 'US core maximum');

  exactKeys(policy.funding, ['primary', 'secondary', 'assumeSaleProceeds'], 'funding');
  if (policy.funding.primary !== 'cash-first' || policy.funding.secondary !== 'existing-holdings-sales-after-settlement' || policy.funding.assumeSaleProceeds !== false) throw new Error('funding policy differs from the approval');

  exactKeys(policy.callReserve, ['status', 'gate', 'floorUsd', 'formula', 'verified90dCallsUsd', 'approvedBufferUsd', 'fxOpsBufferUsd'], 'callReserve');
  if (policy.callReserve.status !== 'incomplete' || policy.callReserve.gate !== 'fail-closed'
      || policy.callReserve.floorUsd !== 240000
      || policy.callReserve.formula !== 'max(floorUsd, verified90dCalls + approvedBuffer + fxOpsBuffer)'
      || ['verified90dCallsUsd', 'approvedBufferUsd', 'fxOpsBufferUsd'].some(key => policy.callReserve[key] !== null)) throw new Error('incomplete CALL ledger must remain fail-closed without guessed values');

  exactKeys(policy.benchmark, ['actual', 'policyShadow', 'market', 'status', 'metrics', 'minimumCompleteQuartersForRanking'], 'benchmark');
  if (policy.benchmark.actual !== 'A' || policy.benchmark.policyShadow !== 'B'
      || policy.benchmark.market !== 'CSPX accumulation' || policy.benchmark.status !== 'baseline-pending'
      || !Array.isArray(policy.benchmark.metrics) || policy.benchmark.metrics.length > 5
      || JSON.stringify(policy.benchmark.metrics) !== JSON.stringify(BENCHMARK_METRICS)
      || policy.benchmark.minimumCompleteQuartersForRanking !== 4) throw new Error('benchmark contract differs from the approval');

  if (!Array.isArray(policy.products) || policy.products.length !== PRODUCT_ROLES.length) throw new Error('product identities are incomplete');
  policy.products.forEach((product, index) => {
    exactKeys(product, ['ticker', 'isin', 'venue', 'role', 'domicile'], `products[${index}]`);
    if (product.ticker !== PRODUCT_TICKERS[index] || product.isin !== PRODUCT_ISINS[index]
        || product.venue !== PRODUCT_VENUES[index] || product.role !== PRODUCT_ROLES[index]
        || product.domicile !== 'Ireland') throw new Error(`products[${index}] differs from the approved identity`);
  });

  exactKeys(policy.controls, ['publishLiveAmounts', 'allowOrders', 'allowOrderChanges', 'allowTransfers', 'retainPreviousOnMissingInputs'], 'controls');
  if (policy.controls.publishLiveAmounts !== false || policy.controls.allowOrders !== false
      || policy.controls.allowOrderChanges !== false || policy.controls.allowTransfers !== false
      || policy.controls.retainPreviousOnMissingInputs !== true) throw new Error('read-only controls must fail closed');
  return policy;
}

export function policyFingerprint(policy) {
  validatePolicy(policy);
  return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

const pct = value => `${Math.round(value * 100)}%`;
const pctRange = (minimum, maximum) => `${Math.round(minimum * 100)}–${Math.round(maximum * 100)}%`;

export function renderPolicySection(policy) {
  validatePolicy(policy);
  const fingerprint = policyFingerprint(policy);
  const { total, us } = policy.allocation;
  const products = Object.fromEntries(policy.products.map(product => [product.role, product.ticker]));
  return `<section id="xuan-ib-policy-v2" data-policy-id="${policy.policyId}" data-policy-status="${policy.status}" data-policy-fingerprint="${fingerprint}">
<!-- ${POLICY_ID}:${fingerprint} -->
<style>
#xuan-ib-policy-v2{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;background:#f6f6f3;color-scheme:light dark;font-size:16px;display:block;box-sizing:border-box;width:100%;max-width:390px;margin:auto;padding:18px 14px 34px;overflow-wrap:anywhere}#xuan-ib-policy-v2 *{box-sizing:border-box;min-width:0}#xuan-ib-policy-v2 .xpv2-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:5px 2px 18px}#xuan-ib-policy-v2 .xpv2-top h1{font-size:25px;margin:0 0 4px}#xuan-ib-policy-v2 .xpv2-muted{color:#6f6f6b;font-size:13px}#xuan-ib-policy-v2 .xpv2-pill{white-space:nowrap;border:1px solid #deded7;border-radius:999px;padding:7px 10px;background:#fff;font-size:12px;font-weight:700}#xuan-ib-policy-v2 .xpv2-card,#xuan-ib-policy-v2 details{background:#fff;border:1px solid #deded7;border-radius:18px;margin:0 0 12px;padding:16px;box-shadow:0 1px 0 #e9e9e4}#xuan-ib-policy-v2 .xpv2-hero{display:grid;gap:10px}#xuan-ib-policy-v2 .xpv2-hero h2,#xuan-ib-policy-v2 .xpv2-call h2{font-size:18px;margin:0}#xuan-ib-policy-v2 .xpv2-status{font-size:22px;font-weight:800}#xuan-ib-policy-v2 .xpv2-note{font-size:14px;line-height:1.45;margin:0}#xuan-ib-policy-v2 .xpv2-targets{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}#xuan-ib-policy-v2 .xpv2-target{border-radius:14px;background:#f4f5f1;padding:12px 8px;text-align:center}#xuan-ib-policy-v2 .xpv2-target b{display:block;font-size:24px}#xuan-ib-policy-v2 .xpv2-target span{font-size:11px;color:#666}#xuan-ib-policy-v2 .xpv2-call{border:2px solid #e6a933;background:#fff8e5}#xuan-ib-policy-v2 .xpv2-call .xpv2-gate{display:inline-block;background:#9c6410;color:#fff;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:800;margin-bottom:9px}#xuan-ib-policy-v2 details{padding:0}#xuan-ib-policy-v2 summary{cursor:pointer;list-style:none;padding:16px;font-weight:800}#xuan-ib-policy-v2 summary::-webkit-details-marker{display:none}#xuan-ib-policy-v2 summary:after{content:"＋";float:right;color:#777}#xuan-ib-policy-v2 .xpv2-body{border-top:1px solid #ecece7;padding:14px 16px 16px}#xuan-ib-policy-v2 .xpv2-row{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid #eeeeea;padding:9px 0;font-size:14px}#xuan-ib-policy-v2 .xpv2-row:last-child{border:0}#xuan-ib-policy-v2 .xpv2-row b{text-align:right;max-width:52%}#xuan-ib-policy-v2 .xpv2-readonly{text-align:center;color:#71716d;font-size:12px;line-height:1.5;margin-top:18px}@media(min-width:600px){#xuan-ib-policy-v2{max-width:430px}}@media(prefers-color-scheme:dark){#xuan-ib-policy-v2{color:#f4f4f2;background:#111214}#xuan-ib-policy-v2 .xpv2-card,#xuan-ib-policy-v2 details{background:#1c1d1f;border-color:#36373a;box-shadow:0 1px 0 #090a0b}#xuan-ib-policy-v2 .xpv2-pill{background:#252629;border-color:#45464a}#xuan-ib-policy-v2 .xpv2-muted,#xuan-ib-policy-v2 .xpv2-readonly{color:#aaa}#xuan-ib-policy-v2 .xpv2-target{background:#282a2d}#xuan-ib-policy-v2 .xpv2-target span{color:#bbb}#xuan-ib-policy-v2 .xpv2-call{background:#33260e;border-color:#b77a16}#xuan-ib-policy-v2 .xpv2-call .xpv2-gate{background:#bd7e1a}#xuan-ib-policy-v2 .xpv2-body,#xuan-ib-policy-v2 .xpv2-row{border-color:#35363a}}
</style>
  <header class="xpv2-top"><div><h1>XUAN-ETF 计划</h1><div class="xpv2-muted">长期配置 · 只读规划</div></div><span class="xpv2-pill">已批准 · 建基线中</span></header>
  <section class="xpv2-card xpv2-hero" aria-labelledby="xpv2-policy-status"><h2 id="xpv2-policy-status">当前状态</h2><div class="xpv2-status">已批准 · 尚未接入日报计算</div><p class="xpv2-note">先核实 CALL 账本，再建立 A／B／C 基线。当前暂不显示可投入金额。</p></section>
  <section class="xpv2-card" aria-labelledby="xpv2-policy-targets"><h2 id="xpv2-policy-targets" style="font-size:18px;margin:0 0 12px">长期目标</h2><div class="xpv2-targets"><div class="xpv2-target"><b>${pct(total.us)}</b><span>美国</span></div><div class="xpv2-target"><b>${pct(total.developedExUs)}</b><span>非美发达</span></div><div class="xpv2-target"><b>${pct(total.emergingMarkets)}</b><span>新兴市场</span></div></div></section>
  <section class="xpv2-card xpv2-call" id="xuan-ib-policy-v2-call-gate" aria-labelledby="xpv2-call-title"><span class="xpv2-gate">资料未齐 · 暂停金额计算</span><h2 id="xpv2-call-title">CALL 账本未核实</h2><p class="xpv2-note">不把缺失值当作 0，不计算可投入金额，也不执行配置。<span class="xpv2-muted">技术规则：fail-closed。</span></p></section>
  <details><summary>美国 65% 如何分</summary><div class="xpv2-body"><div class="xpv2-row"><span>${products['us-small-value']} · 小盘价值</span><b>${pct(us.smallValue)}</b></div><div class="xpv2-row"><span>${products['ai-growth-tilt']} · AI／成长倾斜</span><b>${pctRange(us.aiGrowthTilt.minimum, us.aiGrowthTilt.maximum)}</b></div><div class="xpv2-row"><span>${products['us-large-cap-core']} · 大盘核心</span><b>${pctRange(us.largeCapCore.minimum, us.largeCapCore.maximum)}</b></div><p class="xpv2-note">核心＝60%−倾斜；初始 8% 只在 mapping 与 AI exposure 验证后生效。</p></div></details>
  <details><summary>补仓顺序</summary><div class="xpv2-body"><div class="xpv2-row"><span>① 现有现金</span><b>主要来源</b></div><div class="xpv2-row"><span>② 已有持仓卖出</span><b>结算后才计</b></div><p class="xpv2-note">不预计未成交卖出回款；资金不足时保留上一个已核实方案。</p></div></details>
  <details><summary>范围与排除</summary><div class="xpv2-body"><p class="xpv2-note">范围为 IB-HK 全部资产加 NOAH-HK 现金；GLD、SLV、MSTR、HODL 主题投资不纳入本计划。</p></div></details>
  <details><summary>产品与角色</summary><div class="xpv2-body">${policy.products.map((product, index) => `<div class="xpv2-row"><span>${index + 1}. ${product.ticker}<br><small>${product.isin} · ${product.venue}</small></span><b>${ROLE_LABELS[product.role]}</b></div>`).join('')}</div></details>
  <details><summary>税务要点</summary><div class="xpv2-body"><p class="xpv2-note">候选产品均为爱尔兰注册 UCITS。美国 situs 风险仍需逐项核实；分红税、遗产税及个人适用结论请取得专业税务意见。</p></div></details>
  <details><summary>A／B／C 评分</summary><div class="xpv2-body"><div class="xpv2-row"><span>A</span><b>实际组合</b></div><div class="xpv2-row"><span>B</span><b>现金优先影子方案</b></div><div class="xpv2-row"><span>C</span><b>CSPX 累积型</b></div>${policy.benchmark.metrics.map((metric, index) => `<div class="xpv2-row"><span>${index + 1}. ${METRIC_LABELS[metric]}</span><b>待建基线</b></div>`).join('')}<p class="xpv2-note">至少 4 个完整季度后才排名。</p></div></details>
  <details><summary>与当前日报的关系</summary><div class="xpv2-body"><p class="xpv2-note">当前日报现金计划仍是 operational-v1。policy-v2 是已批准的长期目标，须在 mapping、CALL 账本和 T0 基线完成后版本化接入；不得把旧数字改名为新方案。</p></div></details>
  <p class="xpv2-readonly">只读 · 不下单、不改单、不撤单、不转账<br>任何金融操作均须另行明确批准</p>
</section>`;
}

export function renderPolicyPage(policy) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="XUAN-ETF 计划">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>XUAN-ETF 计划</title>
<style>html,body{margin:0;background:#f6f6f3}body{min-height:100vh}main{width:100%}</style>
</head>
<body>
<main>${renderPolicySection(policy)}</main>
</body>
</html>`;
}

export function validatePolicyPage(html, policy) {
  validatePolicy(policy);
  const source = String(html ?? '');
  const errors = [];
  const fingerprint = policyFingerprint(policy);
  if ((source.match(new RegExp(`<!-- ${POLICY_ID}:${fingerprint} -->`, 'g')) || []).length !== 1) errors.push('canonical policy marker must appear exactly once');
  if (!source.includes(`data-policy-status="${policy.status}"`) || !source.includes(`data-policy-fingerprint="${fingerprint}"`)) errors.push('page identity differs from the approved policy');
  if (/<script\b|\b(?:src|href)\s*=|javascript:|\bfetch\s*\(|XMLHttpRequest|\bon[a-z]+\s*=|url\s*\(/i.test(source)) errors.push('policy page must be static with no script, fetch, event handler or external reference');
  if ((source.match(/id="xuan-ib-policy-v2-call-gate"/g) || []).length !== 1 || !/id="xuan-ib-policy-v2-call-gate"[\s\S]*?资料未齐 · 暂停金额计算[\s\S]*?fail-closed/.test(source)) errors.push('CALL fail-closed gate must be visible');
  const details = [...source.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/gi)];
  if (details.length < 7 || details.some(match => /\bopen\b/i.test(match[1]))) errors.push('secondary sections must be collapsed by default');
  if (details.some(match => /CALL 账本未核实|id="xuan-ib-policy-v2-call-gate"/.test(match[2]))) errors.push('CALL gate must not be collapsible');
  for (const text of ['65%', '23%', '12%', 'USSC · 小盘价值', '0–8%', 'CSPX · 大盘核心', '52–60%', '已批准 · 尚未接入日报计算', '不显示可投入金额', '至少 4 个完整季度后才排名', 'operational-v1', '不得把旧数字改名', 'IB-HK 全部资产加 NOAH-HK 现金', 'GLD、SLV、MSTR、HODL', '不下单、不改单、不撤单、不转账']) if (!source.includes(text)) errors.push(`missing required policy text: ${text}`);
  for (const [value, label] of [['65%', '美国'], ['23%', '非美发达'], ['12%', '新兴市场']]) if (!source.includes(`<div class="xpv2-target"><b>${value}</b><span>${label}</span></div>`)) errors.push(`target ${label} differs from the approved policy`);
  if (/\b(?:NAV|balance|price|position value|as of)\b|數據截至|已投入\s*\$/i.test(source)) errors.push('policy page must not publish live portfolio values');
  if (/<button\b/i.test(source)) errors.push('policy page must not expose an action button');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/xuan-ib-policy-page.mjs POLICY.json');
    process.stdout.write(renderPolicyPage(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
