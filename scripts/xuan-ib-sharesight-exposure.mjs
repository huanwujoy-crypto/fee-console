// Browser-safe factory copied into the index-only manager pane.
export function createRankedExposureCore(){
// Pure adapter for the source-ranked All Together summary. No source reads,
// credentials, publication, guessed per-account rows or ETF component splits.
const categories = ['PE/VC', '对冲基金', '常青基金', '二级市场'];
const fail = code => { throw Error('SHARESIGHT_EXPOSURE_' + code); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 500;
const amount = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e15;
const unique = a => new Set(a).size === a.length;
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const instant = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const pct = (v, d) => d > 0 ? v / d * 100 : null;
const sum = xs => xs.reduce((a, b) => a + b, 0);

const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = v => v === null ? '未取得' : 'USD ' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const percent = v => v === null ? '未取得' : v.toFixed(2) + '%';
const table = rows => rows.length ? '<table><thead><tr><th>序号／名称</th><th>USD金额</th><th>占总资产／占本类资产</th></tr></thead><tbody>'
  + rows.map((r, i) => `<tr><td>${i + 1}. ${esc(r.name)}</td><td>${esc(usd(r.valueUsd))}</td><td>${percent(r.portfolioWeightPct)}／${percent(r.categoryWeightPct)}</td></tr>`).join('')
  + '</tbody></table>' : '<p>已取得范围内无非零持仓。</p>';

// This contract accepts the observed, source-ranked summary. It never
// invents the unseen Investments rows or separate direct/ETF contributions.
const RANKED_EXPOSURE_SCHEMA = 'xuan.sharesight-exposure-ranked.v1';
const EXPOSURE_OBSERVED_TIME_BASIS = '原始Exposure导出文件下载落地时间（按秒）';
const ALL_TOGETHER_SCOPE_SHA256 = '25d1c346d1be590d75d906435e2fec752f851dbfc231c07dd279b5e12adc11c6';
const secondaryBasis = 'Exposure individual security direct plus ETF look-through, includes cash in class denominator';
function buildRankedExposureView(input) {
  check(object(input) && Object.keys(input).sort().join('|') === 'retrievedAt|retrievedAtBasis|schema|summary'
    && input.schema === RANKED_EXPOSURE_SCHEMA, 'RANKED_SCHEMA');
  const s = input.summary;
  check(object(s) && Object.keys(s).sort().join('|') === 'accounts|asOf|classes|currency|limitations|residualETFs|source|sourceXlsxSHA256|totalValueUSD|transferStatus', 'RANKED_KEYS');
  check(object(s) && s.currency === 'USD' && date(s.asOf) && amount(s.totalValueUSD) && s.totalValueUSD > 0, 'RANKED_TOTAL_DATE');
  check(input.retrievedAt === null ? input.retrievedAtBasis === null : input.retrievedAtBasis === EXPOSURE_OBSERVED_TIME_BASIS, 'OBSERVED_TIME_BASIS');
  check(input.retrievedAt === null || instant(input.retrievedAt) && s.asOf <= new Date(Date.parse(input.retrievedAt) + 28800000).toISOString().slice(0, 10), 'DATE');
  check(s.source?.provider === 'Sharesight' && s.source.view === 'All Together'
    && s.source.report === 'Tools Exposure' && s.source.groupBy === 'No grouping'
    && s.source.show === 'Top 500' && s.source.classification === 'Investments→资产类别', 'RANKED_SOURCE');
  check(/^https:\/\/portfolio\.sharesight\.com\/portfolios\/\d+\/tools\/exposure\/\d+\?consolidated=true$/.test(s.source.url ?? ''), 'RANKED_SOURCE');
  check(Array.isArray(s.accounts) && s.accounts.length === 10 && s.accounts.every(text)
    && unique(s.accounts.map(n => n.replaceAll('&amp;', '&'))), 'SCOPE');
  check(Array.isArray(s.classes) && s.classes.length === 4 && s.classes.every((g, i) => g?.name === categories[i]
    && amount(g.totalValueUSD) && g.totalValueUSD > 0 && g.basis === (i === 3 ? secondaryBasis : 'direct')
    && Array.isArray(g.top5) && g.top5.length === 5), 'RANKED_CLASSES');
  check(s.classes[0].sourceCategory === 'VC/PE' && Math.abs(sum(s.classes.map(g => g.totalValueUSD)) - s.totalValueUSD) <= .05, 'CLASS_TOTALS');
  const groups = s.classes.map((g, i) => {
    const keys = g.top5.map(r => i === 3 ? `${r.securityCode}|${r.market}` : r.name);
    check(unique(keys), 'DUPLICATE_EXPOSURE');
    check(g.top5.every((r, n) => object(r) && text(r.name) && amount(r.valueUSD) && r.valueUSD >= 0
      && (n === 0 || g.top5[n - 1].valueUSD >= r.valueUSD)
      && (i !== 3 || text(r.securityCode) && text(r.market))
      && !Object.keys(r).some(k => !['name', 'valueUSD', 'securityCode', 'market'].includes(k))), 'RANKED_ROW');
    check(sum(g.top5.map(r => r.valueUSD)) <= g.totalValueUSD + .05, 'RANKED_TOTAL');
    return {category: g.name, totalUsd: g.totalValueUSD, top: g.top5.map(r => ({name: r.name,
      ...(r.securityCode ? {securityCode: r.securityCode, market: r.market} : {}), valueUsd: r.valueUSD,
      portfolioWeightPct: pct(r.valueUSD, s.totalValueUSD), categoryWeightPct: pct(r.valueUSD, g.totalValueUSD)}))};
  });
  const residual = s.residualETFs;
  check(object(residual) && amount(residual.valueUSD) && residual.valueUSD >= 0 && residual.valueUSD <= groups[3].totalUsd
    && ['weightTotalPct', 'weightSecondaryClassPct'].every(k => Number.isFinite(residual[k]))
    && Math.abs(residual.weightTotalPct - pct(residual.valueUSD, s.totalValueUSD)) <= .0051
    && Math.abs(residual.weightSecondaryClassPct - pct(residual.valueUSD, groups[3].totalUsd)) <= .0051, 'RESIDUAL');
  check(Array.isArray(s.limitations) && s.limitations.length <= 50 && s.limitations.every(text)
    && text(s.transferStatus) && /^[a-f0-9]{64}$/.test(s.sourceXlsxSHA256 ?? ''), 'RANKED_COVERAGE');
  return {schema: RANKED_EXPOSURE_SCHEMA, valuationDate: s.asOf, retrievedAt: input.retrievedAt, retrievedAtBasis: input.retrievedAtBasis,
    portfolioTotalUsd: s.totalValueUSD, groups, residualUsd: residual.valueUSD,
    residualPortfolioWeightPct: pct(residual.valueUSD, s.totalValueUSD), residualCategoryWeightPct: pct(residual.valueUSD, groups[3].totalUsd),
    limitations: [...s.limitations], transferStatus: s.transferStatus,
    coverage: 'source-ranked-summary; constituent rows and component splits not supplied',
    sourceXlsxSha256: s.sourceXlsxSHA256};
}
function renderRankedExposure(input) {
  const m = buildRankedExposureView(input);
  return '<section class="card sharesight-exposure"><h2>All Together · 四类前五大持仓</h2>'
    + `<p>10账户 · USD · 估值 ${esc(m.valuationDate)} · 读取 ${esc(m.retrievedAt ?? '时间未取得')} · 参考数据</p>`
    + m.groups.map((g, i) => `<section><h3>${i + 1}. ${esc(g.category)} · ${i === 3 ? 'Exposure个股' : '直接持仓'}前五</h3><p>本类资产 ${esc(usd(g.totalUsd))}</p>${table(g.top)}</section>`).join('')
    + `<details><summary>来源与覆盖说明</summary><ol><li>时间依据：${esc(m.retrievedAtBasis ?? '未取得')}；不代表首屏查看、行情刷新或分类读取时间。</li><li>Sharesight Tools→Exposure（No grouping／Top 500）与Investments资产类别关联；采用来源已汇总排名，未取得完整逐项穿透明细。源文件哈希只作绑定，不代表已独立核验该文件。</li>`
    + '<li>每项依次显示占All Together总资产和占本类资产比例；二级分母含现金。二级只列个股，不再加ETF本体；不额外乘杠杆或合并不同证券、不同期次基金。</li>'
    + `<li>ETF Residual ${esc(usd(m.residualUsd))}（占总资产 ${percent(m.residualPortfolioWeightPct)}／占二级 ${percent(m.residualCategoryWeightPct)}）；残余不列作个股，不代表完整杠杆风险。</li>`
    + m.limitations.map(x => `<li>${esc(x)}</li>`).join('') + `<li>${esc(m.transferStatus)}</li></ol></details></section>`;
}

return {RANKED_EXPOSURE_SCHEMA,EXPOSURE_OBSERVED_TIME_BASIS,ALL_TOGETHER_SCOPE_SHA256,buildRankedExposureView,renderRankedExposure};
}
const exposureCore=createRankedExposureCore();
export const {RANKED_EXPOSURE_SCHEMA,EXPOSURE_OBSERVED_TIME_BASIS,ALL_TOGETHER_SCOPE_SHA256,buildRankedExposureView,renderRankedExposure}=exposureCore;
