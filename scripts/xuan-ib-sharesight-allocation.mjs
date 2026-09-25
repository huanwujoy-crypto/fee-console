const fail = code => { throw new Error(`Sharesight allocation: ${code}`); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;

export const XUAN_ASSET_GROUP = Object.freeze({ id: 83569, name: '资产类别' });
export const STOCK_CLASS_TARGETS = Object.freeze(new Map([
  ['美国底仓', 45], ['美国科技', 20], ['非美发达', 23], ['新兴市场', 12],
]));
const NON_STOCK_CLASSES = new Set(['主题投资', '防御资产']);
const CASH_LIKE_SYMBOLS = new Set(['VGSH', 'VGIT', 'TLT']);

function reportOf(raw) {
  const report = object(raw?.report) ? raw.report
    : object(raw?.data?.report) ? raw.data.report
      : object(raw?.result?.data?.report) ? raw.result.data.report : null;
  if (!object(report)) fail('REPORT_REQUIRED');
  return report;
}

function instrumentCode(holding) {
  const code = holding?.instrument?.code;
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null;
}

function baseSymbol(holding) {
  const code = instrumentCode(holding);
  return code ? code.split('.')[0] : null;
}

function cashLikeSymbol(holding) {
  const code = instrumentCode(holding);
  if (!code) return null;
  const symbol = code.split('.')[0];
  return CASH_LIKE_SYMBOLS.has(symbol) ? symbol : null;
}

/** Parse the owner's existing Sharesight Custom group as the classification
 * authority. The report value is already in the IB-HK portfolio base currency,
 * so this never sums native-currency IB position values or guesses FX.
 */
export function parseSharesightStockAllocation(raw, { portfolioId = 936247 } = {}) {
  const report = reportOf(raw);
  if (report.portfolio_id !== portfolioId || report.currency?.code !== 'USD'
    || report.grouping !== 'custom_group_category'
    || report.custom_group?.id !== XUAN_ASSET_GROUP.id
    || report.custom_group?.name !== XUAN_ASSET_GROUP.name
    || typeof report.end_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(report.end_date)
    || !Array.isArray(report.holdings) || report.holdings.length > 5_000) fail('REPORT_SCOPE_MISMATCH');
  const sums = new Map([...STOCK_CLASS_TARGETS.keys()].map(name => [name, 0]));
  let excludedValue = 0, ussc = 0;
  const cashLikeSums = new Map([...CASH_LIKE_SYMBOLS].map(symbol => [symbol, 0]));
  const symbolGroups = new Map();
  const seen = new Set();
  for (const holding of report.holdings) {
    if (!object(holding) || !Number.isSafeInteger(holding.id) || holding.id <= 0
      || seen.has(holding.id) || typeof holding.group_name !== 'string'
      || !finite(holding.value)) fail('INVALID_HOLDING');
    seen.add(holding.id);
    const group = holding.group_name.trim();
    const symbol = baseSymbol(holding);
    if (!symbol) fail('INSTRUMENT_CODE_REQUIRED');
    if (STOCK_CLASS_TARGETS.has(group)) sums.set(group, sums.get(group) + holding.value);
    else if (NON_STOCK_CLASSES.has(group)) excludedValue += holding.value;
    else fail(group ? 'UNKNOWN_ASSET_CLASS' : 'UNGROUPED_HOLDING');
    if (instrumentCode(holding) === 'USSC') {
      if (group !== '美国底仓') fail('USSC_CLASS_MISMATCH');
      ussc += holding.value;
    }
    const cashLike = cashLikeSymbol(holding);
    if (cashLike) {
      if (group !== '防御资产') fail('CASH_LIKE_CLASS_MISMATCH');
      cashLikeSums.set(cashLike, cashLikeSums.get(cashLike) + holding.value);
    }
    if (symbolGroups.has(symbol) && symbolGroups.get(symbol) !== group) fail('SYMBOL_CLASS_CONFLICT');
    symbolGroups.set(symbol, group);
  }
  const total = [...sums.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0 || ussc > sums.get('美国底仓')) fail('ALLOCATION_RECONCILIATION_FAILED');
  const categories = [...STOCK_CLASS_TARGETS].map(([label, targetPct]) => {
    const marketValue = sums.get(label);
    return { label, marketValue, currentPct: marketValue / total * 100, targetPct };
  });
  return {
    status: 'ready', source: 'Sharesight', customGroupId: XUAN_ASSET_GROUP.id,
    dataDate: report.end_date, total, categories, ussc,
    usBase: sums.get('美国底仓'), technology: sums.get('美国科技'),
    developed: sums.get('非美发达'), emerging: sums.get('新兴市场'),
    excludedValue, holdingCount: report.holdings.length,
    symbolGroups: Object.fromEntries([...symbolGroups].sort(([a], [b]) => a.localeCompare(b))),
    cashLike: {
      total: [...cashLikeSums.values()].reduce((sum, value) => sum + value, 0),
      items: [...cashLikeSums].filter(([, value]) => value > 0)
        .map(([symbol, amount]) => ({ symbol, amount })),
    },
  };
}

export function parseSharesightCash(raw, { portfolioId } = {}) {
  const report = reportOf(raw);
  if (!Number.isSafeInteger(portfolioId) || report.portfolio_id !== portfolioId
    || report.currency?.code !== 'USD' || typeof report.end_date !== 'string'
    || !Array.isArray(report.cash_accounts) || report.cash_accounts.length > 100) fail('CASH_SCOPE_MISMATCH');
  let total = 0;
  for (const account of report.cash_accounts) {
    if (!object(account) || !finite(account.value)) fail('INVALID_CASH_ACCOUNT');
    total += account.value;
  }
  return { status: 'ready', source: 'Sharesight', dataDate: report.end_date, total, accountCount: report.cash_accounts.length };
}
