import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSharesightReport, aggregateFourBucket, resolveFourBucket, assertFourBucketAdvances,
  validateFourBucketSnapshot, renderFourBucketTemplate, parseFourBucketTemplate, deriveFourBucket,
  listingFromHoldingsResponse, familyPortfolioIds, toMicro, percentOf, formatMicroUsd, detectPagination,
  loadTrustedInputs, FOUR_BUCKET_KIND, LISTING_SOURCE,
} from './xuan-ib-four-bucket.mjs';

// All figures below are synthetic round numbers. They are not account data.
// Row shape mirrors the read-only Sharesight User API v3 performance report:
// holding `id`, nested `instrument`, `instrument_price`, `labels[].name`.
const read = file => JSON.parse(fs.readFileSync(new URL(`../claude/${file}`, import.meta.url), 'utf8'));
const trusted = { registry: read('xuan-ib-portfolio-registry.json'), mapping: read('four-bucket-mapping.json'), cashIdentities: read('xuan-ib-cash-identities-v1.json') };
const NOW = Date.parse('2026-09-08T02:00:00Z');                 // Tue 10:00 HKT
const READ = { readStartedAt: '2026-09-08T01:30:00Z', readCompletedAt: '2026-09-08T01:31:00Z' };
const CUTOFF = '2026-09-05';
const PROXY = trusted.cashIdentities.identities[0];             // reviewed UBS cash proxy identity
const code = fn => { try { fn(); } catch (error) { return error.fourBucketCode ?? `THROWN:${error.message}`; } return 'NO_THROW'; };

const holding = (id, instrumentCode, instrumentName, label, value, { price = 1, quantity = value, market = 'OTHER', currency = 'USD', secType = 'ordinary_shares', extra = {} } = {}) => ({
  id, instrument: { id: id * 10, code: instrumentCode, market_code: market, name: instrumentName, currency_code: currency, friendly_instrument_description_code: secType },
  instrument_currency: { code: currency }, valid_position: true, quantity, value, instrument_price: price,
  labels: [{ id: 1, name: label, color: 'x', holding_ids: [], portfolio_ids: [] }], group_name: 'Ordinary Shares', number_of_unconfirmed_transactions: 0, ...extra,
});
// Native cash-account row shape as returned inside the performance report.
const cash = (id, name, value, currency = 'USD') => ({ id, key: id, name, source: null, value, currency: { code: currency, id: 5, symbol: '$' }, portfolio: { id: 0, consolidated: false } });
const SELF = 'https://example.invalid/performance?consolidated=false&end_date=2026-09-05&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false';
const raw = (portfolioId, holdings, cash_accounts, { value = null, currency = 'USD', extra = {}, self = SELF } = {}) => ({
  result: { mode: 'read_only', portfolio: { id: portfolioId, currency_code: currency }, data: { report: {
    portfolio_id: portfolioId, end_date: CUTOFF, currency: { code: currency }, holdings, cash_accounts, include_sales: false,
    value: value ?? [...holdings, ...cash_accounts].reduce((sum, row) => sum + row.value, 0), ...extra,
  }, api_transaction: { id: 1 }, links: { portfolio: 'https://example.invalid/portfolio', ...(self === null ? {} : { self }) } } },
});
// Listing = all historical holding identities, no state, no values.
const listing = (portfolioId, holdings, listingOnlyIds = []) => ({
  source: LISTING_SOURCE, portfolioId, readCompletedAt: '2026-09-08T01:32:00Z',
  holdingIds: [...holdings.map(row => row.id), ...listingOnlyIds],
});
const fixture = () => {
  const spec = {
    936238: [[holding(18589470, '景林金色中国基金', 'Fund A', 'Semi Liquid', 1000), holding(20184705, '汉领资本', 'Fund B', 'Semi Liquid', 2000), holding(100001, 'SYN-ETF', 'Synthetic ETF', 'Highly Liquid', 500)], [cash(901, 'USD Cash', 100)]],
    936240: [[holding(200001, 'SYN-BOND', 'Synthetic Bond', 'Highly Liquid', 700), holding(200002, 'SYN-PE', 'Synthetic PE', 'Illiquid', 300)], []],
    1021748: [[holding(300001, 'SYN-HF', 'Synthetic HF', 'Semi Liquid', 1500)], [cash(903, 'USD', 50)]],
    1031350: [[holding(21097888, 'FOF-GCM', 'Core A', 'Semi Liquid', 800), holding(PROXY.holdingId, '现金帐户', 'Cash', 'Highly Liquid', 200, { price: 1 }), holding(400001, 'SYN-EG', 'Synthetic Evergreen', 'Semi Liquid', 1200)], []],
    936247: [[holding(500001, 'SYN-STOCK', 'Synthetic Stock', 'Highly Liquid', 900)], [cash(905, 'USD', 100)]],
    936243: [[holding(600001, 'SYN-FUND', 'Synthetic Fund', 'Illiquid', 400)], []],
    1350095: [[holding(700001, 'SYN-EG2', 'Synthetic Evergreen 2', 'Semi Liquid', 600)], [cash(907, 'HKD', 100, 'HKD')]],
  };
  return Object.fromEntries(Object.entries(spec).map(([id, [holdings, cashRows]]) => [id, { holdings, cashRows }]));
};
const reads = (mutate = () => {}) => {
  const data = fixture(); mutate(data);
  return Object.entries(data).map(([id, { holdings, cashRows, listingOnly = [], rawOptions = {}, listingOverride = undefined, readOverride = {} }]) => {
    const portfolioId = Number(id);
    return { portfolioId, raw: raw(portfolioId, holdings, cashRows, rawOptions), ...READ, ...readOverride,
      listing: listingOverride === undefined ? listing(portfolioId, holdings, listingOnly) : listingOverride };
  });
};
const normalizeAll = (mutate) => reads(mutate).map(item => normalizeSharesightReport(item.raw, { ...trusted, ...item }));
const aggregate = (mutate, options = {}) => aggregateFourBucket({ ...trusted, reports: normalizeAll(mutate), now: NOW, ...options });

test('micro arithmetic and percent formatting are exact and deterministic', () => {
  assert.equal(String(toMicro(1234.5678)), '1234567800');
  assert.equal(String(toMicro(-0.5)), '-500000');
  assert.equal(percentOf(2650_000000n, 10450_000000n), '25.36');
  assert.equal(percentOf(700_000000n, 10450_000000n), '6.70');
  assert.equal(formatMicroUsd('1234567800'), '1234.57');
  assert.equal(formatMicroUsd('-999999'), '-1.00');
  assert.equal(code(() => percentOf(1n, 0n)), 'NON_POSITIVE_TOTAL');
  assert.deepEqual(familyPortfolioIds(trusted.registry), [936238, 936240, 936243, 936247, 1021748, 1031350, 1350095]);
});

test('happy path: gross buckets, exact percentages, dates kept distinct, net unavailable, deterministic', () => {
  const snapshot = aggregate();
  assert.equal(snapshot.kind, FOUR_BUCKET_KIND);
  assert.equal(snapshot.totals.totalUsdMicro, String(10450_000000n));
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.totals.buckets).map(([bucket, item]) => [bucket, item.usdMicro])),
    { highly_liquid: String(2650_000000n), vc_pe: String(700_000000n), hedge_fund: String(3300_000000n), evergreen: String(3800_000000n) });
  assert.deepEqual(snapshot.totals.percent, { highly_liquid: '25.36', vc_pe: '6.70', hedge_fund: '31.58', evergreen: '36.36' });
  assert.equal(snapshot.threeLayer.semi_liquid.usdMicro, String(7100_000000n));
  assert.deepEqual(snapshot.evergreenNet, { status: 'unavailable', reason: 'PENDING_REDEMPTION_EVIDENCE_REQUIRED' });
  assert.equal(snapshot.reportCutoff.latest, CUTOFF);
  assert.equal(snapshot.readWindow.completedAt, READ.readCompletedAt);
  assert.notEqual(snapshot.reportCutoff.latest, snapshot.readWindow.completedAt.slice(0, 10));
  assert.equal(snapshot.underlyingNav.rowsWithNavDate, 0);
  assert.equal(snapshot.underlyingNav.rowsWithoutNavDate, 12);
  assert.equal(snapshot.coverage.cashProxyRows, 1);
  assert.equal(snapshot.coverage.cashAccountRows, 4);
  assert.equal(snapshot.coverage.listingOnlyIdentities, 0);
  assert.deepEqual(snapshot.inputs.sourceFingerprints[0].reportParameters, { includeSales: false, includeLimited: false, consolidated: false, reportCombined: false });
  assert.equal(snapshot.coverage.unresolvedRows, 0);
  assert.equal(snapshot.coverage.byRule.holding_override, 3);
  assert.equal(snapshot.inputs.cashProxyNormalization.schemaVersion, 1);
  assert.match(snapshot.inputs.pendingRedemptionBasis, /no evidence supplied/);
  assert.deepEqual(aggregate(), snapshot);
  assert.doesNotThrow(() => validateFourBucketSnapshot(snapshot, { registry: trusted.registry }));
});

test('composite source name and aliases: agreement required, conflicts fail closed', () => {
  const ubs = normalizeAll().find(report => report.portfolioId === 1031350);
  assert.equal(ubs.holdings[1].name, PROXY.name);
  assert.equal(ubs.holdings[0].symbol, 'FOF-GCM');
  assert.equal(ubs.holdings[0].instrumentId, 210978880);
  const explicit = normalizeAll(data => { data[936243].holdings[0].name = 'SYN-FUND | OTHER Synthetic Fund'; }).find(report => report.portfolioId === 936243);
  assert.equal(explicit.holdings[0].name, 'SYN-FUND | OTHER Synthetic Fund');
  assert.equal(code(() => normalizeAll(data => { data[936243].holdings[0].name = 'Different'; })), 'HOLDING_NAME_AMBIGUOUS_FIELD');
  assert.equal(code(() => normalizeAll(data => { data[936243].holdings[0].holding_id = 600009; })), 'HOLDING_AMBIGUOUS_FIELD');
  assert.equal(code(() => normalizeAll(data => { data[936243].holdings[0].instrument_currency = { code: 'HKD' }; })), 'HOLDING_CURRENCY_AMBIGUOUS_FIELD');
});

test('USD report currency, portfolio identity and scope are enforced', () => {
  assert.equal(code(() => normalizeAll(data => { data[936240].rawOptions = { currency: 'HKD' }; })), 'REPORT_CURRENCY_NOT_USD');
  const item = reads()[0];
  assert.equal(code(() => normalizeSharesightReport(item.raw, { ...trusted, ...item, portfolioId: 936240 })), 'PORTFOLIO_MISMATCH');
  assert.equal(code(() => normalizeSharesightReport(raw(1350094, [], []), { ...trusted, ...item, portfolioId: 1350094 })), 'PORTFOLIO_NOT_IN_SCOPE');
  const six = normalizeAll().filter(report => report.portfolioId !== 936243);
  assert.equal(code(() => aggregateFourBucket({ ...trusted, reports: six, now: NOW })), 'SCOPE_INCOMPLETE');
  const eight = [...normalizeAll(), normalizeAll()[0]];
  assert.equal(code(() => aggregateFourBucket({ ...trusted, reports: eight, now: NOW })), 'DUPLICATE_REPORT');
});

test('duplicate rows, labels and unregistered cash never classify by guess', () => {
  assert.equal(code(() => normalizeAll(data => { data[936240].holdings.push(holding(200001, 'AGAIN', 'Again', 'Highly Liquid', 1)); })), 'DUPLICATE_HOLDING_ROW');
  assert.equal(code(() => normalizeAll(data => { data[936247].cashRows.push(cash(905, 'Again', 1)); })), 'DUPLICATE_CASH_ACCOUNT_ROW');
  // Case and spelling are exact: a near-miss is preserved raw and marked, never mapped by name.
  assert.equal(code(() => aggregate(data => { data[936240].holdings[0].labels = [{ name: 'highly liquid' }]; })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => aggregate(data => { data[936240].holdings[0].labels = [{ name: 'Mystery' }]; })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => aggregate(data => { data[936240].holdings[0].labels = []; })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => normalizeAll(data => { data[936240].holdings[0].labels = [{ name: 'Highly Liquid' }, { name: 'Semi Liquid' }]; })), 'AMBIGUOUS_LIQUIDITY_LABEL');
  const tagged = normalizeAll(data => { data[936240].holdings[0].labels = [{ name: 'Tax note' }, { name: 'Highly Liquid' }]; }).find(report => report.portfolioId === 936240);
  assert.equal(tagged.holdings[0].assetClass, 'Highly Liquid');
  assert.deepEqual(tagged.holdings[0].sourceLabels, ['Tax note', 'Highly Liquid']);
  assert.equal(tagged.holdings[0].labelStatus, 'approved');
  // A holding labelled Cash without a reviewed identity is never guessed as cash.
  assert.equal(code(() => aggregate(data => { data[936243].holdings.push(holding(600002, 'MMF', 'Money market thing', 'Cash', 10)); })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => aggregate(data => { data[936240].holdings.push(holding(200003, 'SEMI', 'Unmapped semi', 'Semi Liquid', 10)); })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => normalizeAll(data => { data[936240].holdings[0].valid_position = false; })), 'INVALID_POSITION_ROW');
  assert.equal(code(() => normalizeAll(data => { data[936240].holdings[0].number_of_unconfirmed_transactions = 1; })), 'UNCONFIRMED_TRANSACTIONS');
});

test('label precedence: approved portfolio or holding rules decide without a label; no rule plus no label stays unresolved', () => {
  // IB-HK has the portfolio-wide rule `all`; HSBC-HK has `all_non_cash`; NOAH-US has no rule.
  const unlabeled = normalizeAll(data => {
    data[936247].holdings[0].labels = [];
    data[1350095].holdings[0].labels = [{ name: 'Custodian tag' }];
  });
  const ibhk = unlabeled.find(report => report.portfolioId === 936247).holdings[0];
  const hsbc = unlabeled.find(report => report.portfolioId === 1350095).holdings[0];
  assert.deepEqual([ibhk.assetClass, ibhk.labelStatus, ibhk.sourceLabels], ['no approved liquidity label', 'missing', []]);
  assert.deepEqual([hsbc.assetClass, hsbc.labelStatus, hsbc.sourceLabels], ['unrecognized liquidity label', 'unrecognized', ['Custodian tag']]);
  const snapshot = aggregateFourBucket({ ...trusted, reports: unlabeled, now: NOW });
  assert.deepEqual(snapshot.coverage.labels, { approved: 10, missing: 1, unrecognized: 1 });
  assert.equal(snapshot.coverage.byRule.portfolio_rule, 4);
  assert.equal(snapshot.totals.totalUsdMicro, String(10450_000000n));          // same buckets as the labelled fixture
  assert.equal(snapshot.totals.buckets.evergreen.usdMicro, String(3800_000000n));
  // A holding override also decides without a label.
  const overridden = aggregate(data => { data[936238].holdings[0].labels = []; });
  assert.equal(overridden.coverage.byRule.holding_override, 3);
  // A source label never overrides an approved portfolio-wide rule.
  const conflicting = aggregate(data => { data[936247].holdings[0].labels = [{ name: 'Illiquid' }]; });
  assert.equal(conflicting.totals.buckets.highly_liquid.usdMicro, String(2650_000000n));
  // No rule and no approved label: unresolved, snapshot fails; unmapped Semi Liquid still fails.
  assert.equal(code(() => aggregate(data => { data[936240].holdings[0].labels = []; })), 'UNRESOLVED_CLASSIFICATION');
  assert.equal(code(() => aggregate(data => { data[936240].holdings[0].labels = [{ name: 'Semi Liquid' }]; })), 'UNRESOLVED_CLASSIFICATION');
});

test('source security type is preserved but never decides cash; ordinary rows carry no invented pending flag', () => {
  const reports = normalizeAll(data => { data[936240].holdings[0].instrument.friendly_instrument_description_code = 'managed_fund'; });
  const ubs = reports.find(report => report.portfolioId === 1031350);
  assert.equal(ubs.holdings[1].sourceSecurityType, 'ordinary_shares');
  const snapshot = aggregateFourBucket({ ...trusted, reports, now: NOW });
  assert.equal(snapshot.coverage.cashProxyRows, 1);
  assert.equal(snapshot.totals.buckets.highly_liquid.usdMicro, String(2650_000000n));
});

test('native cash migration: a registered legacy proxy need not stay live; both representations at once are ambiguous', () => {
  // The proxy holding has left the open-positions report; a native cash account now supplies cash.
  // The listing still carries the proxy identity as history, which is a diagnostic only.
  const migrate = data => {
    const proxyRow = data[1031350].holdings.splice(1, 1)[0];
    data[1031350].cashRows.push(cash(154271, 'UBS CASH', 200));
    data[1031350].listingOnly = [proxyRow.id];
  };
  const snapshot = aggregate(migrate);
  assert.equal(snapshot.coverage.cashProxyRows, 0);
  assert.equal(snapshot.coverage.cashAccountRows, 5);
  assert.equal(snapshot.coverage.listingOnlyIdentities, 1);
  assert.equal(snapshot.totals.buckets.highly_liquid.usdMicro, String(2650_000000n));
  assert.equal(snapshot.totals.totalUsdMicro, String(10450_000000n));
  assert.equal(snapshot.inputs.pendingRedemptionBasis.startsWith('no evidence supplied'), true);
  const ubs = normalizeAll(migrate).find(report => report.portfolioId === 1031350);
  assert.deepEqual(ubs.cashAccounts[0], { portfolioId: 1031350, cashAccountId: 154271, name: 'UBS CASH', recordType: 'cash_account', assetClass: 'Cash', currency: 'USD', valueMicro: String(200_000000n) });
  assert.deepEqual(ubs.listingOnlyHoldingIds, [PROXY.holdingId]);
  // Proxy still valued AND a native cash account in the same portfolio: fail closed.
  assert.equal(code(() => aggregate(data => { data[1031350].cashRows.push(cash(154271, 'UBS CASH', 200)); })), 'CASH_REPRESENTATION_AMBIGUOUS');
  // Native cash in other portfolios never conflicts with the UBS proxy.
  assert.equal(aggregate().coverage.cashAccountRows, 4);
  // A cash row whose currency object disagrees with a currency code string is ambiguous.
  assert.equal(code(() => normalizeAll(data => { data[936247].cashRows[0].currency_code = 'HKD'; })), 'CASH_ACCOUNT_CURRENCY_AMBIGUOUS_FIELD');
});

test('cash proxy identity is exact; name, price or currency drift is a conflict, not a guess', () => {
  assert.equal(code(() => aggregate(data => { data[1031350].holdings[1].instrument.name = 'Cash USD'; })), 'CASH_IDENTITY_CONFLICT');
  assert.equal(code(() => aggregate(data => { delete data[1031350].holdings[1].instrument_price; })), 'CASH_IDENTITY_CONFLICT');
  assert.equal(code(() => aggregate(data => { data[1031350].holdings[1].instrument_price = 1.01; })), 'CASH_IDENTITY_CONFLICT');
  assert.equal(code(() => aggregate(data => { const row = data[1031350].holdings[1]; row.instrument.currency_code = 'HKD'; row.instrument_currency = { code: 'HKD' }; })), 'CASH_IDENTITY_CONFLICT');
});

test('pagination signals, listing mismatch and missing listing all fail closed', () => {
  assert.equal(code(() => normalizeAll(data => { data[936238].rawOptions = { extra: { links: { next: 'page-2' } } }; })), 'PAGINATED_RESPONSE');
  assert.equal(code(() => normalizeAll(data => { data[936238].rawOptions = { extra: { total_pages: 2 } }; })), 'PAGINATED_RESPONSE');
  assert.equal(detectPagination({ links: { self: 'x', portfolio: 'y' }, api_transaction: { id: 1 } }), false);
  // A valued performance row without a listing identity is an inconsistency.
  assert.equal(code(() => normalizeAll(data => { data[936238].listingOverride = listing(936238, data[936238].holdings.slice(1)); })), 'HOLDINGS_LISTING_MISMATCH');
  assert.equal(code(() => normalizeAll(data => { data[936238].listingOverride = null; })), 'PAGINATION_UNVERIFIED');
  assert.equal(code(() => normalizeAll(data => { data[936238].listingOverride = { ...listing(936238, data[936238].holdings), source: 'sharesight_get_performance' }; })), 'LISTING_SOURCE_INVALID');
  assert.equal(code(() => normalizeAll(data => { data[936238].listingOverride = listing(936238, [...data[936238].holdings, data[936238].holdings[0]]); })), 'LISTING_IDS_INVALID');
});

test('listing-only identities are unvalued diagnostics: never inferred closed, never valued, never classified', () => {
  // The listing is every historical holding identity; the open-positions report is the value snapshot.
  const report = normalizeAll(data => { data[936240].listingOnly = [200009, 424242]; }).find(item => item.portfolioId === 936240);
  assert.deepEqual(report.listingOnlyHoldingIds, [200009, 424242]);
  assert.equal(report.holdings.length, 2);
  assert.deepEqual(report.listing, { source: LISTING_SOURCE, listedHoldingCount: 4, valuedHoldingCount: 2, readCompletedAt: '2026-09-08T01:32:00Z' });
  const snapshot = aggregate(data => { data[936240].listingOnly = [200009, 424242]; });
  assert.equal(snapshot.coverage.listingOnlyIdentities, 2);
  assert.deepEqual(snapshot.coverage.listingOnlyByPortfolio.find(item => item.portfolioId === 936240), { portfolioId: 936240, count: 2 });
  assert.equal(snapshot.totals.totalUsdMicro, String(10450_000000n));   // unchanged: nothing invented for them
  assert.equal(snapshot.coverage.totalRows, 16);
});

test('listing evidence can be built from a holdings response; report parameters and sub-totals are enforced', () => {
  const rows = fixture()[936240].holdings;
  const listingRaw = { result: { mode: 'read_only', portfolio: { id: 936240 }, data: { holdings: rows.map(row => ({ id: row.id, symbol: row.instrument.code, valid_position: true })), links: { self: 'x' } } } };
  const built = listingFromHoldingsResponse(listingRaw, { portfolioId: 936240, readCompletedAt: '2026-09-08T01:32:00Z' });
  assert.deepEqual(built, { source: LISTING_SOURCE, portfolioId: 936240, readCompletedAt: '2026-09-08T01:32:00Z', holdingIds: [200001, 200002] });
  assert.equal(code(() => listingFromHoldingsResponse({ ...listingRaw, result: { ...listingRaw.result, links: { next: 'p2' } } }, { portfolioId: 936240, readCompletedAt: '2026-09-08T01:32:00Z' })), 'PAGINATED_RESPONSE');
  assert.equal(code(() => listingFromHoldingsResponse(listingRaw, { portfolioId: 936238, readCompletedAt: '2026-09-08T01:32:00Z' })), 'LISTING_PORTFOLIO_MISMATCH');
  // The current-position snapshot must be the open-positions report of one portfolio.
  assert.equal(code(() => normalizeAll(data => { data[936240].rawOptions = { extra: { include_sales: true } }; })), 'REPORT_PARAMETERS_INVALID');
  assert.equal(code(() => normalizeAll(data => { data[936240].rawOptions = { self: SELF.replace('consolidated=false', 'consolidated=true') }; })), 'REPORT_PARAMETERS_INVALID');
  assert.equal(code(() => normalizeAll(data => { data[936240].rawOptions = { self: SELF.replace('report_combined=false', 'report_combined=true') }; })), 'REPORT_PARAMETERS_INVALID');
  const limited = normalizeAll(data => { data[936240].rawOptions = { self: SELF.replace('include_limited=false', 'include_limited=true') }; }).find(item => item.portfolioId === 936240);
  assert.equal(limited.reportParameters.includeLimited, true);
  const noLink = normalizeAll(data => { data[936240].rawOptions = { self: null }; }).find(item => item.portfolioId === 936240);
  assert.deepEqual(noLink.reportParameters, { includeSales: false, includeLimited: null, consolidated: null, reportCombined: null });
  // Sharesight group sub-totals cover holdings only; the report value adds cash accounts.
  const subtotals = normalizeAll(data => { data[936247].rawOptions = { extra: { sub_totals: [{ group_name: 'Ordinary Shares', value: 900 }] } }; }).find(item => item.portfolioId === 936247);
  assert.equal(subtotals.reconciliation.withinTolerance, true);
  assert.equal(code(() => normalizeAll(data => { data[936247].rawOptions = { extra: { sub_totals: [{ group_name: 'Ordinary Shares', value: 1000 }] } }; })), 'SUBTOTALS_MISMATCH');
  const derived = deriveFourBucket({ reads: reads().map(item => ({ ...item, listing: { raw: { result: { mode: 'read_only', portfolio: { id: item.portfolioId }, data: { holdings: item.listing.holdingIds.map(id => ({ id })) } } }, readCompletedAt: '2026-09-08T01:32:00Z' } })), now: NOW, trusted });
  assert.equal(derived.status, 'fresh');
});

test('holdings plus cash must reconcile to the report value; cutoff cannot postdate the read', () => {
  assert.equal(code(() => normalizeAll(data => { data[936240].rawOptions = { value: 1000.5 }; })), 'RECONCILIATION_MISMATCH');
  const withinTolerance = normalizeAll(data => { data[936240].rawOptions = { value: 1000.02 }; }).find(report => report.portfolioId === 936240);
  assert.equal(withinTolerance.reconciliation.withinTolerance, true);
  assert.equal(code(() => normalizeAll(data => { data[936240].readOverride = { readStartedAt: '2026-09-04T01:30:00Z', readCompletedAt: '2026-09-04T01:31:00Z' }; })), 'REPORT_CUTOFF_AFTER_READ');
  assert.equal(code(() => normalizeAll(data => { data[936240].readOverride = { readCompletedAt: '2026-09-04T01:31:00Z' }; })), 'INVALID_READ_WINDOW');
  assert.equal(code(() => normalizeAll(data => { data[936240].holdings[0].nav_date = '2026-09-06'; })), 'HOLDING_NAV_DATE_INVALID');
  const dated = normalizeAll(data => { data[936240].holdings[0].nav_date = '2026-08-29'; }).find(report => report.portfolioId === 936240);
  assert.equal(dated.holdings[0].navDate, '2026-08-29');
});

test('pending-redemption net needs explicit evidence bound to an evergreen row and never touches highly_liquid', () => {
  const evidence = { schemaVersion: 1, evidenceDate: '2026-09-05', evidenceRef: 'Synthetic redemption notice', items: [{ portfolioId: 1350095, holdingId: 700001, amountUsd: 250 }] };
  const snapshot = aggregate(undefined, { pendingRedemption: evidence });
  assert.equal(snapshot.evergreenNet.status, 'available');
  assert.equal(snapshot.evergreenNet.netUsdMicro, String(3550_000000n));
  assert.equal(snapshot.totals.buckets.evergreen.usdMicro, String(3800_000000n));
  assert.equal(snapshot.totals.buckets.highly_liquid.usdMicro, String(2650_000000n));
  assert.doesNotThrow(() => validateFourBucketSnapshot(snapshot));
  assert.equal(code(() => aggregate(undefined, { pendingRedemption: { ...evidence, items: [{ portfolioId: 936240, holdingId: 200001, amountUsd: 1 }] } })), 'PENDING_REDEMPTION_ROW_NOT_EVERGREEN');
  assert.equal(code(() => aggregate(undefined, { pendingRedemption: { ...evidence, items: [{ portfolioId: 1350095, holdingId: 700001, amountUsd: 601 }] } })), 'PENDING_REDEMPTION_EXCEEDS_VALUE');
  assert.equal(code(() => aggregate(undefined, { pendingRedemption: { ...evidence, evidenceRef: 'https://example.invalid' } })), 'PENDING_REDEMPTION_REF_INVALID');
  assert.equal(code(() => aggregate(undefined, { pendingRedemption: { ...evidence, evidenceDate: '2026-09-09' } })), 'PENDING_REDEMPTION_DATE_INVALID');
  assert.equal(code(() => aggregate(undefined, { pendingRedemption: { ...evidence, items: [{ portfolioId: 1031350, holdingId: PROXY.holdingId, amountUsd: 1 }] } })), 'CASH_IDENTITY_CONFLICT');
});

test('resolution: fresh, last-good fallback with explicit age, never zero, never regressed', () => {
  const previous = aggregate();
  const later = { readStartedAt: '2026-09-09T01:30:00Z', readCompletedAt: '2026-09-09T01:31:00Z' };
  const laterReads = mutate => reads(data => { for (const id of Object.keys(data)) data[id].readOverride = later; if (mutate) mutate(data); });
  const compute = () => aggregateFourBucket({ ...trusted, now: Date.parse('2026-09-09T02:00:00Z'), reports: laterReads().map(item => normalizeSharesightReport(item.raw, { ...trusted, ...item })) });
  const fresh = resolveFourBucket({ compute, previous, now: Date.parse('2026-09-09T02:00:00Z'), registry: trusted.registry });
  assert.equal(fresh.status, 'fresh'); assert.equal(fresh.previousStatus, 'superseded');
  const failed = resolveFourBucket({ compute: () => { throw Object.assign(new Error('x'), { fourBucketCode: 'RECONCILIATION_MISMATCH' }); }, previous, now: Date.parse('2026-09-10T02:00:00Z') });
  assert.equal(failed.status, 'fallback'); assert.equal(failed.reason, 'RECONCILIATION_MISMATCH'); assert.equal(failed.ageDays, 2);
  assert.equal(failed.snapshot.reportCutoff.latest, CUTOFF);
  const none = resolveFourBucket({ compute: () => { throw new Error('boom'); }, now: NOW });
  assert.deepEqual(none, { status: 'unavailable', reason: 'AGGREGATION_FAILED' });
  const tampered = { ...previous, totals: { ...previous.totals, totalUsdMicro: '1' } };
  assert.equal(resolveFourBucket({ compute: () => { throw new Error('boom'); }, previous: tampered, now: NOW }).previousReason, 'SNAPSHOT_FINGERPRINT');
  assert.equal(code(() => assertFourBucketAdvances(previous, previous)), 'READ_WINDOW_NOT_ADVANCED');
  const regressed = resolveFourBucket({ compute: () => aggregateFourBucket({ ...trusted, now: Date.parse('2026-09-09T02:00:00Z'),
    reports: laterReads(data => { for (const id of Object.keys(data)) data[id].rawOptions = { extra: { end_date: '2026-09-01' } }; }).map(item => normalizeSharesightReport(item.raw, { ...trusted, ...item })) }), previous, now: Date.parse('2026-09-09T02:00:00Z') });
  assert.equal(regressed.status, 'fallback'); assert.equal(regressed.reason, 'CUTOFF_REGRESSED');
});

test('template transport round-trips, rejects duplicates and tampering', () => {
  const snapshot = aggregate();
  const template = renderFourBucketTemplate(snapshot, { registry: trusted.registry });
  assert.deepEqual(parseFourBucketTemplate(`<body>${template}</body>`, { registry: trusted.registry }), snapshot);
  assert.equal(code(() => parseFourBucketTemplate(template + template)), 'TEMPLATE_NOT_UNIQUE');
  assert.equal(code(() => parseFourBucketTemplate(template.replace('"fresh"', '"stale"'))), 'SNAPSHOT_VERSION');
  assert.equal(code(() => parseFourBucketTemplate(template.replace('2650000000', '2650000001'))), 'SNAPSHOT_FINGERPRINT');
  assert.equal(code(() => validateFourBucketSnapshot({ ...snapshot, extra: 1 })), 'SNAPSHOT_KEYS');
});

test('deriveFourBucket runs the ordinary per-report path against trusted repository inputs', () => {
  const result = deriveFourBucket({ reads: reads(), now: NOW, trusted: loadTrustedInputs() });
  assert.equal(result.status, 'fresh');
  assert.equal(result.snapshot.totals.percent.evergreen, '36.36');
  const broken = deriveFourBucket({ reads: reads(data => { data[936240].rawOptions = { value: 5 }; }), previous: result.snapshot, now: NOW + 86_400_000, trusted });
  assert.equal(broken.status, 'fallback'); assert.equal(broken.reason, 'RECONCILIATION_MISMATCH'); assert.equal(broken.ageDays, 1);
});
