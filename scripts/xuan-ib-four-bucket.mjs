#!/usr/bin/env node
// Deterministic Sharesight normalizer and four-bucket GROSS aggregator.
//
// Pure functions: no network, no live reads, no financial-account writes, no
// repository writes. Inputs are already captured read-only Sharesight
// performance responses plus an independent holdings listing, the approved
// repository mapping (claude/four-bucket-mapping.json), the reviewed
// cash-identity registry and optional explicit pending-redemption evidence.
//
// Fail closed everywhere: never fill a missing value with zero, never guess
// cash or a bucket from a name, never accept a paginated or unreconciled
// response. The Sharesight report cutoff (end_date) and the read window are
// kept explicitly distinct from underlying NAV dates, which a performance
// report does not provide for private funds. Pending-redemption NET stays
// unavailable without explicit dated evidence; a pending redemption is never
// moved into highly_liquid.
//
// Integration target: the ordinary per-report direct-read path with a
// validated last-good fallback (resolveFourBucket). No weekly cache layer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';
import { auditClassification, validateClassificationMapping } from './xuan-ib-classification-audit.mjs';
import { resolveCashIdentity, validateCashIdentityRegistry } from './xuan-ib-cash-identity.mjs';
import { canonicalJson, fingerprint } from './xuan-ib-run-manifest.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';

export const FOUR_BUCKET_KIND = 'xuan-ib-four-bucket-gross:v1';
export const FOUR_BUCKET_TEMPLATE_ID = 'xuan-ib-four-bucket-v1';
export const BUCKETS = Object.freeze(['highly_liquid', 'vc_pe', 'hedge_fund', 'evergreen']);
export const THREE_LAYERS = Object.freeze({
  highly_liquid: Object.freeze(['highly_liquid']),
  semi_liquid: Object.freeze(['hedge_fund', 'evergreen']),
  illiquid: Object.freeze(['vc_pe']),
});
// Exact source liquidity labels accepted from Sharesight holding labels.
// Anything else is unrecognized and fails closed; case matters.
export const APPROVED_SOURCE_LABELS = Object.freeze(['Highly Liquid', 'Semi Liquid', 'Illiquid', 'Cash']);
export const NATIVE_CASH_LABEL = 'Cash';
// Explicit markers for rows whose source labels carry no approved liquidity
// label. They are never invented labels: the trusted audit classifies such a
// row only through an approved holding override or portfolio-wide rule, and
// otherwise leaves it unresolved, which fails the snapshot.
export const MISSING_LABEL_MARKER = 'no approved liquidity label';
export const UNRECOGNIZED_LABEL_MARKER = 'unrecognized liquidity label';
export const LISTING_SOURCE = 'sharesight_get_holdings';
// Missing flags remain missing. A legacy proxy requires the resolver's
// explicit source proof; absence from a pending-evidence list is not proof.
// Native cash accounts require no legacy-proxy exception.
export const CASH_PROXY_NORMALIZATION = Object.freeze({
  schemaVersion: 1,
  identity: 'approved registry portfolioId + holdingId, exact normalized source name, explicit source currency, explicit source unit price',
  isCash: 'cash identity comes from the reviewed registry or native cash account type; explicit source conflicts are rejected',
  pendingRedemption: 'legacy proxy requires explicit source false; missing is never derived from absence in an evidence list; source true or a naming evidence item is a conflict',
  ordinaryRows: 'source pending flags are preserved; dated pending evidence may add true but cannot contradict explicit source false; otherwise the field stays absent',
});
export const MICRO = 1_000_000n;
export const CENT_MICRO = 10_000n;
const HKT_OFFSET_MS = 8 * 3_600_000;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_ROWS = 10_000;
const NAV_NOTE = 'Performance rows carry no underlying NAV date; private-fund NAV may be older than reportCutoff. Rows without navDate are counted, never dated.';
const SNAPSHOT_KEYS = ['schemaVersion', 'kind', 'status', 'scope', 'readWindow', 'reportCutoff', 'underlyingNav', 'totals',
  'threeLayer', 'evergreenNet', 'coverage', 'reconciliation', 'inputs', 'fingerprint'];

// Field aliases, in precedence order, verified against a read-only Sharesight
// User API v3 response shape on 2026-09-06. When more than one alias is present
// the values must agree, otherwise the row is ambiguous and fails closed.
// The audit name is the composite `instrument.code | market_code instrument.name`,
// which is the exact form recorded in the reviewed cash-identity registry.
export const SHARESIGHT_FIELDS = Object.freeze({
  holding: Object.freeze({
    holdingId: ['holding_id', 'id'],
    instrumentId: ['instrument_id', 'instrument.id'],
    symbol: ['symbol', 'instrument.code'],
    name: ['name'],
    instrumentCode: ['instrument.code'],
    marketCode: ['instrument.market_code'],
    instrumentName: ['instrument.name'],
    value: ['value'],
    quantity: ['quantity'],
    unitPrice: ['instrument_price', 'price', 'unit_price'],
    currency: ['instrument_currency.code', 'instrument.currency_code', 'currency_code', 'currency'],
    labels: ['labels'],
    navDate: ['nav_date', 'price_date', 'last_price_date', 'last_priced_at'],
    securityType: ['instrument.friendly_instrument_description_code', 'security_type', 'instrument.type'],
    validPosition: ['valid_position'],
    unconfirmedTransactions: ['number_of_unconfirmed_transactions'],
  }),
  cashAccount: Object.freeze({
    cashAccountId: ['cash_account_id', 'id', 'key'],
    name: ['name'],
    value: ['value', 'balance'],
    currency: ['currency_code', 'currency.code', 'currency'],
  }),
});

export const fail = (code, detail = null) => { throw Object.assign(new Error(code), { fourBucketCode: code, detail }); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isCalendarDate = value => typeof value === 'string' && DATE_RE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instantMs = value => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
export const hktDateOfMs = ms => new Date(ms + HKT_OFFSET_MS).toISOString().slice(0, 10);
const exactKeys = (value, keys, label) => {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${label}_KEYS`);
  return value;
};
const toId = (value, label) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) return Number(value);
  return fail(`${label}_INVALID_ID`);
};
const text = (value, label, max = 200) => {
  if (typeof value !== 'string') fail(`${label}_INVALID_TEXT`);
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > max) fail(`${label}_INVALID_TEXT`);
  return normalized;
};
const currencyCode = (value, label) => {
  const code = isObject(value) ? value.code : value;
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : fail(`${label}_INVALID_CURRENCY`);
};
const finiteNumber = (value, label) => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : fail(`${label}_NOT_FINITE`));

/** Exact decimal micro-units (1e-6) from a JSON number, via its fixed decimal
 * text, so sums are integer-exact and reproducible across runs. */
export function toMicro(value, label = 'VALUE') {
  finiteNumber(value, label);
  const match = value.toFixed(6).match(/^(-?)(\d+)\.(\d{6})$/);
  if (!match) fail(`${label}_NOT_FINITE`);
  const magnitude = BigInt(match[2] + match[3]);
  return match[1] === '-' ? -magnitude : magnitude;
}
const microString = /^-?(?:0|[1-9]\d*)$/;
const parseMicro = (value, label) => (typeof value === 'string' && microString.test(value) ? BigInt(value) : fail(`${label}_INVALID_MICRO`));
const abs = value => (value < 0n ? -value : value);

/** Whole USD with cents, rounded half away from zero. Display helper only. */
export function formatMicroUsd(micro) {
  const value = parseMicro(String(micro), 'FORMAT');
  const cents = (abs(value) + CENT_MICRO / 2n) / CENT_MICRO;
  const whole = cents / 100n, fraction = cents % 100n;
  return `${value < 0n ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Percent of a positive total with two decimals, rounded half away from zero,
 * computed from unrounded micro-units. */
export function percentOf(partMicro, totalMicro) {
  const part = BigInt(partMicro), total = BigInt(totalMicro);
  if (total <= 0n) fail('NON_POSITIVE_TOTAL');
  const hundredths = (abs(part) * 10_000n + total / 2n) / total;
  return `${part < 0n ? '-' : ''}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

const getPath = (row, dotted) => dotted.split('.').reduce((value, key) => (isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined), row);
function pick(row, aliases, label, { required = true, normalize = value => value } = {}) {
  const present = aliases.map(alias => getPath(row, alias)).filter(value => value !== undefined && value !== null).map(normalize);
  if (!present.length) return required ? fail(`${label}_MISSING_FIELD`) : undefined;
  const first = present[0];
  if (present.some(value => canonicalJson(value) !== canonicalJson(first))) fail(`${label}_AMBIGUOUS_FIELD`);
  return first;
}
// Sharesight expresses currency either as a code string or as an object with
// a `code`; both forms must agree when present together.
const currencyOf = value => (isObject(value) && typeof value.code === 'string' ? value.code : value);
const pickCurrency = (row, aliases, label, options = {}) => pick(row, aliases, label, { ...options, normalize: currencyOf });

function checkRowPortfolio(row, expectedId) {
  const references = [];
  if (Object.hasOwn(row, 'portfolio')) {
    if (!isObject(row.portfolio) || !Object.hasOwn(row.portfolio, 'id')) fail('ROW_PORTFOLIO_INVALID');
    references.push(row.portfolio.id);
    if (row.portfolio.consolidated === true) fail('ROW_PORTFOLIO_MISMATCH');
  }
  if (Object.hasOwn(row, 'portfolio_id')) references.push(row.portfolio_id);
  if (references.some(id => id !== expectedId)) fail('ROW_PORTFOLIO_MISMATCH');
}

function sourceFlags(row) {
  const flags = {};
  for (const [field, aliases] of [['isCash', ['isCash', 'is_cash']], ['pendingRedemption', ['pendingRedemption', 'pending_redemption']]]) {
    const values = aliases.filter(key => Object.hasOwn(row, key)).map(key => row[key]);
    if (!values.length) continue;
    if (values.some(value => typeof value !== 'boolean')) fail('SOURCE_FLAG_INVALID');
    if (values.some(value => value !== values[0])) fail('SOURCE_FLAG_CONFLICT');
    flags[field] = values[0];
  }
  return flags;
}

/** Any pagination signal inside a captured response means the holdings array
 * is not provably complete. The Sharesight `links.self` shape is not a signal. */
export function detectPagination(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => detectPagination(item, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (['next', 'next_page', 'next_cursor', 'next_page_token', 'cursor'].includes(name) && child) return true;
    if (name === 'has_more' && child === true) return true;
    if (['total_pages', 'page_count'].includes(name) && typeof child === 'number' && child > 1) return true;
    if (detectPagination(child, depth + 1)) return true;
  }
  return false;
}

export function familyPortfolioIds(registry) {
  if (!isObject(registry) || !Array.isArray(registry.portfolios)) fail('INVALID_REGISTRY');
  const ids = registry.portfolios.filter(entry => entry?.role === 'family').map(entry => toId(entry.portfolioId, 'REGISTRY'));
  if (!ids.length || new Set(ids).size !== ids.length) fail('INVALID_REGISTRY');
  return ids.sort((a, b) => a - b);
}
function scopedEntry(registry, portfolioId, roles = ['family']) {
  familyPortfolioIds(registry);
  if (!Array.isArray(roles) || !roles.length
    || roles.some(role => !['family', 'ai_only'].includes(role))) fail('INVALID_PORTFOLIO_ROLES');
  const entry = registry.portfolios.find(item => item.portfolioId === portfolioId);
  if (!entry || !roles.includes(entry.role)) fail('PORTFOLIO_NOT_IN_SCOPE', portfolioId);
  return entry;
}

/** The audit/identity name: an explicit full `name`, or the composite
 * `instrument.code | market_code instrument.name`. Both present must agree. */
function sourceName(row, fields) {
  const full = pick(row, fields.holding.name, 'HOLDING_NAME', { required: false });
  const code = pick(row, fields.holding.instrumentCode, 'HOLDING_NAME', { required: false });
  const market = pick(row, fields.holding.marketCode, 'HOLDING_NAME', { required: false });
  const name = pick(row, fields.holding.instrumentName, 'HOLDING_NAME', { required: false });
  const composite = code === undefined && market === undefined && name === undefined ? undefined
    : `${text(code, 'HOLDING_NAME', 120)} | ${text(market, 'HOLDING_NAME', 40)} ${text(name, 'HOLDING_NAME', 120)}`;
  if (full === undefined && composite === undefined) fail('HOLDING_NAME_MISSING_FIELD');
  const normalizedFull = full === undefined ? undefined : text(full, 'HOLDING_NAME', 300);
  if (normalizedFull !== undefined && composite !== undefined && normalizedFull !== composite) fail('HOLDING_NAME_AMBIGUOUS_FIELD');
  return normalizedFull ?? composite;
}

/** Source liquidity label from the Sharesight holding labels. Group names such
 * as "Ordinary Shares" are not liquidity. At most one approved label may be
 * present; none yields an explicit marker plus the preserved raw labels, so an
 * approved portfolio-wide or holding rule can still decide the bucket without
 * an invented label, while a marked row with no rule stays unresolved. */
function sourceLabel(row, fields, holdingId) {
  const labels = pick(row, fields.holding.labels, 'HOLDING_LABEL', { required: false }) ?? [];
  if (!Array.isArray(labels) || labels.length > 50) fail('HOLDING_LABEL_INVALID', holdingId);
  const sourceLabels = labels.map(label => (isObject(label) ? label.name : label)).filter(name => typeof name === 'string').map(name => text(name, 'HOLDING_LABEL', 80));
  const approved = [...new Set(sourceLabels.filter(name => APPROVED_SOURCE_LABELS.includes(name)))];
  if (approved.length > 1) fail('AMBIGUOUS_LIQUIDITY_LABEL', { holdingId, labels: approved });
  if (approved.length === 1) return { assetClass: approved[0], sourceLabels, labelStatus: 'approved' };
  return sourceLabels.length
    ? { assetClass: UNRECOGNIZED_LABEL_MARKER, sourceLabels, labelStatus: 'unrecognized' }
    : { assetClass: MISSING_LABEL_MARKER, sourceLabels, labelStatus: 'missing' };
}

/** Build the listing evidence from a captured read-only holdings response.
 * The listing is the set of all historical holding identities; it carries no
 * open/closed state and no values, so nothing beyond identity is read here. */
export function listingFromHoldingsResponse(raw, { portfolioId, readCompletedAt } = {}) {
  const expectedId = toId(portfolioId, 'LISTING');
  if (!isObject(raw) || !isObject(raw.result) || raw.result.mode !== 'read_only' || !isObject(raw.result.portfolio)
      || !isObject(raw.result.data) || !Array.isArray(raw.result.data.holdings) || raw.result.data.holdings.length > MAX_ROWS) fail('LISTING_SHAPE_INVALID');
  if (raw.result.portfolio.id !== expectedId) fail('LISTING_PORTFOLIO_MISMATCH');
  if (detectPagination(raw)) fail('PAGINATED_RESPONSE');
  const holdingIds = raw.result.data.holdings.map(row => {
    if (!isObject(row)) fail('LISTING_SHAPE_INVALID');
    checkRowPortfolio(row, expectedId);
    return toId(row.id, 'LISTING');
  });
  return { source: LISTING_SOURCE, portfolioId: expectedId, readCompletedAt, holdingIds };
}

/** Completeness contract (see claude/xuan-ib-four-bucket-v1.md §3): the
 * open-positions performance report is the authoritative current snapshot.
 * Every valued performance row must carry a listing identity. Listing-only
 * identities are historical or excluded holdings: they are recorded as
 * unvalued membership diagnostics and are never inferred closed or valued. */
function validateListing(listing, portfolioId, performanceIds) {
  if (!isObject(listing)) fail('PAGINATION_UNVERIFIED');
  exactKeys(listing, ['source', 'portfolioId', 'readCompletedAt', 'holdingIds'], 'LISTING');
  if (listing.source !== LISTING_SOURCE) fail('LISTING_SOURCE_INVALID');
  if (listing.portfolioId !== portfolioId) fail('LISTING_PORTFOLIO_MISMATCH');
  if (instantMs(listing.readCompletedAt) === null) fail('LISTING_READ_TIME_INVALID');
  if (!Array.isArray(listing.holdingIds) || listing.holdingIds.length > MAX_ROWS) fail('LISTING_IDS_INVALID');
  const listed = listing.holdingIds.map(value => toId(value, 'LISTING'));
  if (new Set(listed).size !== listed.length) fail('LISTING_IDS_INVALID');
  const listedSet = new Set(listed);
  const unlisted = [...performanceIds].filter(id => !listedSet.has(id));
  if (unlisted.length) fail('HOLDINGS_LISTING_MISMATCH', { unlistedPerformanceIds: unlisted });
  const listingOnlyHoldingIds = listed.filter(id => !performanceIds.has(id)).sort((a, b) => a - b);
  return { listedHoldingCount: listed.length, valuedHoldingCount: performanceIds.size, listingOnlyHoldingIds, readCompletedAt: listing.readCompletedAt };
}

/** Report parameters echoed in the Sharesight self link. A consolidated or
 * combined report is not one portfolio's snapshot; include_sales must be off
 * for the current-position snapshot; include_limited is recorded only. */
function reportParameters(raw, report) {
  const self = raw?.result?.data?.links?.self;
  const params = {};
  if (typeof self === 'string') {
    for (const pair of self.split('?')[1]?.split('&') ?? []) {
      const [key, value] = pair.split('=');
      if (['consolidated', 'include_limited', 'include_sales', 'report_combined'].includes(key)) params[key] = value === 'true' ? true : value === 'false' ? false : null;
    }
  }
  const includeSales = report.include_sales !== undefined ? report.include_sales : params.include_sales ?? null;
  if (includeSales !== false) fail('REPORT_PARAMETERS_INVALID', { include_sales: includeSales });
  if (params.consolidated === true || params.report_combined === true) fail('REPORT_PARAMETERS_INVALID', { consolidated: params.consolidated, report_combined: params.report_combined });
  return { includeSales, includeLimited: params.include_limited ?? null, consolidated: params.consolidated ?? null, reportCombined: params.report_combined ?? null };
}

/** Normalize one captured read-only performance response for one family
 * portfolio. Validates USD report currency, portfolio identity, duplicate
 * rows, source liquidity labels, native cash-account identity, absence of
 * pagination plus an independent listing cross-check, and holdings-plus-cash
 * reconciliation against the report value. Returns exact micro-unit strings.
 * The report must be the open-positions snapshot (include_sales false); any
 * listing-only identity is returned as an unvalued diagnostic. */
export function normalizeSharesightReport(raw, { registry, portfolioId, readStartedAt, readCompletedAt,
  listing, fields = SHARESIGHT_FIELDS, portfolioRoles = ['family'] } = {}) {
  const expectedId = toId(portfolioId, 'PORTFOLIO');
  const entry = scopedEntry(registry, expectedId, portfolioRoles);
  let shell;
  try { shell = unwrapSource('sharesight', raw); } catch (error) { fail('SOURCE_SHAPE_INVALID', error.message); }
  const { portfolio, data: { report } } = shell.result;
  if (portfolio.id !== expectedId) fail('PORTFOLIO_MISMATCH', { expected: expectedId, actual: portfolio.id });
  if (portfolio.currency_code !== 'USD') fail('REPORT_CURRENCY_NOT_USD', portfolio.currency_code);
  const started = instantMs(readStartedAt), completed = instantMs(readCompletedAt);
  if (started === null || completed === null || started > completed) fail('INVALID_READ_WINDOW');
  if (!isCalendarDate(report.end_date)) fail('INVALID_REPORT_CUTOFF');
  if (report.end_date > hktDateOfMs(completed)) fail('REPORT_CUTOFF_AFTER_READ');
  if (detectPagination(raw)) fail('PAGINATED_RESPONSE');
  if (report.holdings.length + report.cash_accounts.length > MAX_ROWS) fail('TOO_MANY_ROWS');
  if (report.include_sales !== undefined && typeof report.include_sales !== 'boolean') fail('INCLUDE_SALES_INVALID');
  const parameters = reportParameters(raw, report);

  const holdings = [];
  const seen = new Set();
  for (const [index, row] of report.holdings.entries()) {
    if (!isObject(row)) fail('HOLDING_ROW_INVALID', index);
    checkRowPortfolio(row, expectedId);
    const flags = sourceFlags(row);
    const holdingId = toId(pick(row, fields.holding.holdingId, 'HOLDING'), 'HOLDING');
    if (seen.has(holdingId)) fail('DUPLICATE_HOLDING_ROW', holdingId);
    seen.add(holdingId);
    const validPosition = pick(row, fields.holding.validPosition, 'HOLDING_POSITION', { required: false });
    if (validPosition !== undefined && validPosition !== true) fail('INVALID_POSITION_ROW', holdingId);
    const unconfirmed = pick(row, fields.holding.unconfirmedTransactions, 'HOLDING_UNCONFIRMED', { required: false });
    if (unconfirmed !== undefined && (!Number.isSafeInteger(unconfirmed) || unconfirmed < 0)) fail('HOLDING_UNCONFIRMED_INVALID', holdingId);
    if (unconfirmed > 0) fail('UNCONFIRMED_TRANSACTIONS', holdingId);
    const name = sourceName(row, fields);
    const { assetClass, sourceLabels, labelStatus } = sourceLabel(row, fields, holdingId);
    const valueMicro = toMicro(pick(row, fields.holding.value, 'HOLDING_VALUE'), 'HOLDING_VALUE');
    const quantity = pick(row, fields.holding.quantity, 'HOLDING_QUANTITY', { required: false });
    if (quantity !== undefined) finiteNumber(quantity, 'HOLDING_QUANTITY');
    const currency = pickCurrency(row, fields.holding.currency, 'HOLDING_CURRENCY', { required: false });
    const unitPrice = pick(row, fields.holding.unitPrice, 'HOLDING_PRICE', { required: false });
    const instrumentId = pick(row, fields.holding.instrumentId, 'INSTRUMENT', { required: false });
    const symbol = pick(row, fields.holding.symbol, 'HOLDING_SYMBOL', { required: false });
    // The listing venue the source itself publishes, preserved verbatim. It is
    // read here and nowhere else: the four-bucket classification never uses it,
    // and the AI-risk input needs the source's own market code rather than a
    // venue something upstream decided to attach. Absent stays null.
    const marketCode = pick(row, fields.holding.marketCode, 'HOLDING_MARKET_CODE', { required: false });
    const navDate = pick(row, fields.holding.navDate, 'HOLDING_NAV_DATE', { required: false });
    if (navDate !== undefined && (!isCalendarDate(navDate) || navDate > report.end_date)) fail('HOLDING_NAV_DATE_INVALID', holdingId);
    const securityType = pick(row, fields.holding.securityType, 'HOLDING_SECURITY_TYPE', { required: false });
    holdings.push({
      portfolioId: expectedId, holdingId, ...flags,
      instrumentId: instrumentId === undefined ? null : toId(instrumentId, 'INSTRUMENT'),
      symbol: symbol === undefined ? null : text(symbol, 'HOLDING_SYMBOL', 120),
      venue: marketCode === undefined ? null : text(marketCode, 'HOLDING_MARKET_CODE', 40),
      name, recordType: 'holding', assetClass, sourceLabels, labelStatus,
      // Preserved verbatim for review only; never used to decide cash or bucket.
      sourceSecurityType: securityType === undefined ? null : text(securityType, 'HOLDING_SECURITY_TYPE', 60),
      currency: currency === undefined ? null : currencyCode(currency, 'HOLDING_CURRENCY'),
      unitPrice: unitPrice === undefined ? null : finiteNumber(unitPrice, 'HOLDING_PRICE'),
      quantity: quantity === undefined ? null : quantity,
      valueMicro: String(valueMicro),
      navDate: navDate === undefined ? null : navDate,
    });
  }

  const cashAccounts = [];
  const seenCash = new Set();
  for (const [index, row] of report.cash_accounts.entries()) {
    if (!isObject(row)) fail('CASH_ACCOUNT_ROW_INVALID', index);
    checkRowPortfolio(row, expectedId);
    const flags = sourceFlags(row);
    if (flags.isCash === false || flags.pendingRedemption === true) fail('NATIVE_CASH_FLAG_CONFLICT');
    const cashAccountId = toId(pick(row, fields.cashAccount.cashAccountId, 'CASH_ACCOUNT'), 'CASH_ACCOUNT');
    if (seenCash.has(cashAccountId)) fail('DUPLICATE_CASH_ACCOUNT_ROW', cashAccountId);
    seenCash.add(cashAccountId);
    cashAccounts.push({
      portfolioId: expectedId, cashAccountId, ...flags,
      name: text(pick(row, fields.cashAccount.name, 'CASH_ACCOUNT_NAME'), 'CASH_ACCOUNT_NAME'),
      recordType: 'cash_account', assetClass: NATIVE_CASH_LABEL,
      currency: currencyCode(pickCurrency(row, fields.cashAccount.currency, 'CASH_ACCOUNT_CURRENCY'), 'CASH_ACCOUNT_CURRENCY'),
      valueMicro: String(toMicro(pick(row, fields.cashAccount.value, 'CASH_ACCOUNT_VALUE'), 'CASH_ACCOUNT_VALUE')),
    });
  }

  const listed = validateListing(listing, expectedId, seen);
  const holdingsSum = holdings.reduce((total, row) => total + BigInt(row.valueMicro), 0n);
  const sum = cashAccounts.reduce((total, row) => total + BigInt(row.valueMicro), holdingsSum);
  const reportValueMicro = toMicro(report.value, 'REPORT_VALUE');
  const toleranceMicro = CENT_MICRO * BigInt(holdings.length + cashAccounts.length + 1);
  const differenceMicro = sum - reportValueMicro;
  if (abs(differenceMicro) > toleranceMicro) {
    fail('RECONCILIATION_MISMATCH', { portfolioId: expectedId, differenceMicro: String(differenceMicro), toleranceMicro: String(toleranceMicro) });
  }
  // Sharesight's group sub-totals cover holdings only; the report value adds
  // cash accounts. Both identities must hold when sub-totals are present.
  if (report.sub_totals !== undefined) {
    if (!Array.isArray(report.sub_totals)) fail('SUBTOTALS_INVALID');
    const subtotal = report.sub_totals.reduce((total, group) => total + toMicro(isObject(group) ? group.value : undefined, 'SUBTOTAL_VALUE'), 0n);
    if (abs(subtotal - holdingsSum) > CENT_MICRO * BigInt(report.sub_totals.length + holdings.length + 1)) fail('SUBTOTALS_MISMATCH', { portfolioId: expectedId });
  }
  return {
    schemaVersion: 1, portfolioId: expectedId, portfolioName: entry.portfolioName,
    reportCutoffDate: report.end_date, readStartedAt, readCompletedAt, reportParameters: parameters,
    reportValueMicro: String(reportValueMicro), holdings, cashAccounts,
    listingOnlyHoldingIds: listed.listingOnlyHoldingIds,
    listing: { source: LISTING_SOURCE, listedHoldingCount: listed.listedHoldingCount, valuedHoldingCount: listed.valuedHoldingCount, readCompletedAt: listed.readCompletedAt },
    reconciliation: { sumMicro: String(sum), reportValueMicro: String(reportValueMicro), differenceMicro: String(differenceMicro), toleranceMicro: String(toleranceMicro), withinTolerance: true },
    sourceFingerprint: fingerprint(raw),
    sourceBytes: Buffer.byteLength(JSON.stringify(raw)),
  };
}

function pendingRedemptionIndex(evidence, nowMs) {
  if (evidence === null || evidence === undefined) return { index: new Map(), evidence: null };
  exactKeys(evidence, ['schemaVersion', 'evidenceDate', 'evidenceRef', 'items'], 'PENDING_REDEMPTION');
  if (evidence.schemaVersion !== 1) fail('PENDING_REDEMPTION_VERSION');
  if (!isCalendarDate(evidence.evidenceDate) || evidence.evidenceDate > hktDateOfMs(nowMs)) fail('PENDING_REDEMPTION_DATE_INVALID');
  const evidenceRef = text(evidence.evidenceRef, 'PENDING_REDEMPTION_REF', 200);
  if (/https?:\/\/|www\./i.test(evidenceRef)) fail('PENDING_REDEMPTION_REF_INVALID');
  if (!Array.isArray(evidence.items) || evidence.items.length > 200) fail('PENDING_REDEMPTION_ITEMS_INVALID');
  const index = new Map();
  for (const item of evidence.items) {
    exactKeys(item, ['portfolioId', 'holdingId', 'amountUsd'], 'PENDING_REDEMPTION_ITEM');
    const key = `${toId(item.portfolioId, 'PENDING_REDEMPTION_ITEM')}:holding:${toId(item.holdingId, 'PENDING_REDEMPTION_ITEM')}`;
    if (index.has(key)) fail('PENDING_REDEMPTION_DUPLICATE_ITEM', key);
    const amountMicro = toMicro(item.amountUsd, 'PENDING_REDEMPTION_AMOUNT');
    if (amountMicro <= 0n) fail('PENDING_REDEMPTION_AMOUNT_NOT_FINITE');
    index.set(key, amountMicro);
  }
  return { index, evidence: { schemaVersion: 1, evidenceDate: evidence.evidenceDate, evidenceRef, items: [...index.entries()].map(([key, amount]) => ({ key, amountMicro: String(amount) })) } };
}

function auditRows(reports, cashIdentities, pending) {
  const rows = [];
  const values = new Map();
  let cashProxyRows = 0;
  for (const report of reports) {
    let proxiesInPortfolio = 0;
    for (const holding of report.holdings) {
      const key = `${holding.portfolioId}:holding:${holding.holdingId}`;
      const namedByEvidence = pending.has(key);
      if (namedByEvidence && holding.pendingRedemption === false) fail('PENDING_SOURCE_CONFLICT');
      const flags = sourceFlags(holding);
      if (namedByEvidence) flags.pendingRedemption = true;
      const candidate = {
        portfolioId: holding.portfolioId, holdingId: holding.holdingId, name: holding.name, recordType: 'holding',
        currency: holding.currency, unitPrice: holding.unitPrice, ...flags,
      };
      const resolved = resolveCashIdentity(cashIdentities, candidate);
      if (resolved.status === 'unresolved') fail('CASH_IDENTITY_CONFLICT', { key, reason: resolved.reason, errors: resolved.errors });
      const isCash = resolved.status === 'resolved';
      if (!isCash && holding.isCash === true) fail('UNREGISTERED_CASH_CLAIM');
      if (isCash) { cashProxyRows += 1; proxiesInPortfolio += 1; }
      rows.push({
        portfolioId: holding.portfolioId, holdingId: holding.holdingId, name: holding.name, recordType: 'holding', isCash,
        assetClass: holding.assetClass, ...(Object.hasOwn(flags, 'pendingRedemption') ? { pendingRedemption: flags.pendingRedemption } : {}),
      });
      values.set(key, BigInt(holding.valueMicro));
    }
    // A registered legacy proxy is not required to stay live: after migration
    // to a native cash account it simply stops appearing in the open-positions
    // report. Both representations valued in the same portfolio at once cannot
    // be told apart from double counting, so that state fails closed.
    if (proxiesInPortfolio > 0 && report.cashAccounts.length > 0) {
      fail('CASH_REPRESENTATION_AMBIGUOUS', { portfolioId: report.portfolioId, cashProxyRows: proxiesInPortfolio, cashAccountRows: report.cashAccounts.length });
    }
    for (const cash of report.cashAccounts) {
      if (cash.isCash === false || cash.pendingRedemption === true) fail('NATIVE_CASH_FLAG_CONFLICT');
      rows.push({ portfolioId: cash.portfolioId, cashAccountId: cash.cashAccountId, name: cash.name, recordType: 'cash_account', isCash: true, assetClass: NATIVE_CASH_LABEL });
      values.set(`${cash.portfolioId}:cash:${cash.cashAccountId}`, BigInt(cash.valueMicro));
    }
  }
  return { rows, values, cashProxyRows };
}

/** Aggregate normalized family reports into gross four-bucket totals. The
 * classification itself is delegated to the trusted audit module; this
 * function only validates scope, joins exact values, sums, and dates. */
export function aggregateFourBucket({ reports, registry, mapping, cashIdentities, pendingRedemption = null, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  if (!Number.isFinite(nowMs)) fail('INVALID_CLOCK');
  const mappingErrors = validateClassificationMapping(mapping);
  if (mappingErrors.length) fail('INVALID_MAPPING', mappingErrors);
  const identityErrors = validateCashIdentityRegistry(cashIdentities);
  if (identityErrors.length) fail('INVALID_CASH_IDENTITIES', identityErrors);
  const familyIds = familyPortfolioIds(registry);
  if (!Array.isArray(reports)) fail('INVALID_REPORTS');
  const byId = new Map();
  for (const report of reports) {
    if (!isObject(report) || report.schemaVersion !== 1) fail('INVALID_REPORTS');
    if (byId.has(report.portfolioId)) fail('DUPLICATE_REPORT', report.portfolioId);
    if (!familyIds.includes(report.portfolioId)) fail('SCOPE_UNEXPECTED_PORTFOLIO', report.portfolioId);
    if (report.reconciliation?.withinTolerance !== true) fail('RECONCILIATION_MISMATCH', report.portfolioId);
    byId.set(report.portfolioId, report);
  }
  const missing = familyIds.filter(id => !byId.has(id));
  if (missing.length) fail('SCOPE_INCOMPLETE', missing);
  const ordered = familyIds.map(id => byId.get(id));
  for (const report of ordered) {
    if (instantMs(report.readCompletedAt) === null || instantMs(report.readCompletedAt) > nowMs) fail('READ_TIME_INVALID', report.portfolioId);
  }

  const pending = pendingRedemptionIndex(pendingRedemption, nowMs);
  const { rows, values, cashProxyRows } = auditRows(ordered, cashIdentities, pending.index);
  const audit = auditClassification({ mapping, holdings: rows, scope: { portfolioIds: familyIds, complete: true } });
  if (audit.mappingErrors.length) fail('INVALID_MAPPING', audit.mappingErrors);
  if (audit.scopeErrors.length) fail('INVALID_SCOPE', audit.scopeErrors);
  if (audit.coverage.missingPortfolioIds.length) fail('SCOPE_INCOMPLETE', audit.coverage.missingPortfolioIds);
  const unresolved = audit.rows.filter(row => row.status !== 'classified');
  if (unresolved.length) {
    fail('UNRESOLVED_CLASSIFICATION', unresolved.map(row => ({ key: row.key, reason: row.unresolvedReason })));
  }

  const bucketMicro = Object.fromEntries(BUCKETS.map(bucket => [bucket, 0n]));
  const bucketRows = Object.fromEntries(BUCKETS.map(bucket => [bucket, 0]));
  const bucketByKey = new Map();
  let consumed = 0;
  for (const row of audit.rows) {
    if (!values.has(row.key)) fail('VALUE_JOIN_FAILED', row.key);
    bucketMicro[row.bucket] += values.get(row.key);
    bucketRows[row.bucket] += 1;
    bucketByKey.set(row.key, row.bucket);
    consumed += 1;
  }
  if (consumed !== values.size) fail('VALUE_JOIN_FAILED', { consumed, values: values.size });
  const totalMicro = BUCKETS.reduce((total, bucket) => total + bucketMicro[bucket], 0n);
  if (totalMicro <= 0n) fail('NON_POSITIVE_TOTAL');

  let evergreenNet = { status: 'unavailable', reason: 'PENDING_REDEMPTION_EVIDENCE_REQUIRED' };
  if (pending.evidence) {
    let pendingMicro = 0n;
    for (const [key, amount] of pending.index) {
      if (bucketByKey.get(key) !== 'evergreen') fail('PENDING_REDEMPTION_ROW_NOT_EVERGREEN', key);
      if (amount > values.get(key)) fail('PENDING_REDEMPTION_EXCEEDS_VALUE', key);
      pendingMicro += amount;
    }
    evergreenNet = {
      status: 'available', evidenceDate: pending.evidence.evidenceDate, evidenceRef: pending.evidence.evidenceRef,
      pendingUsdMicro: String(pendingMicro), netUsdMicro: String(bucketMicro.evergreen - pendingMicro),
      coverageDisplayOnly: true, highlyLiquidUnchanged: true,
    };
  }

  const navRows = ordered.flatMap(report => report.holdings);
  const rowsWithNavDate = navRows.filter(row => row.navDate !== null).length;
  const cutoffs = ordered.map(report => report.reportCutoffDate);
  const snapshot = {
    schemaVersion: 1, kind: FOUR_BUCKET_KIND, status: 'fresh',
    scope: { portfolioIds: familyIds, complete: true, basis: 'registry family role; listing cross-check; per-portfolio reconciliation' },
    readWindow: {
      startedAt: ordered.map(report => report.readStartedAt).sort()[0],
      completedAt: ordered.map(report => report.readCompletedAt).sort().at(-1),
    },
    reportCutoff: {
      earliest: [...cutoffs].sort()[0], latest: [...cutoffs].sort().at(-1),
      perPortfolio: ordered.map(report => ({ portfolioId: report.portfolioId, endDate: report.reportCutoffDate })),
    },
    underlyingNav: { rowsWithNavDate, rowsWithoutNavDate: navRows.length - rowsWithNavDate, note: NAV_NOTE },
    totals: {
      totalUsdMicro: String(totalMicro),
      buckets: Object.fromEntries(BUCKETS.map(bucket => [bucket, { usdMicro: String(bucketMicro[bucket]), rows: bucketRows[bucket] }])),
      percent: Object.fromEntries(BUCKETS.map(bucket => [bucket, percentOf(bucketMicro[bucket], totalMicro)])),
    },
    threeLayer: Object.fromEntries(Object.entries(THREE_LAYERS).map(([layer, buckets]) => {
      const micro = buckets.reduce((total, bucket) => total + bucketMicro[bucket], 0n);
      return [layer, { usdMicro: String(micro), percent: percentOf(micro, totalMicro) }];
    })),
    evergreenNet,
    coverage: {
      totalRows: audit.summary.totalRows, holdingRows: navRows.length,
      cashAccountRows: ordered.reduce((count, report) => count + report.cashAccounts.length, 0), cashProxyRows,
      // Unvalued membership diagnostics: historical or excluded identities that
      // the open-positions report does not value. Never inferred closed.
      listingOnlyIdentities: ordered.reduce((count, report) => count + report.listingOnlyHoldingIds.length, 0),
      listingOnlyByPortfolio: ordered.map(report => ({ portfolioId: report.portfolioId, count: report.listingOnlyHoldingIds.length })),
      // Source label coverage: rows without an approved label were classified
      // only through approved holding or portfolio-wide rules, never by name.
      labels: navRows.reduce((counts, row) => { counts[row.labelStatus] += 1; return counts; }, { approved: 0, missing: 0, unrecognized: 0 }),
      classifiedRows: audit.summary.classifiedRows, unresolvedRows: audit.summary.unresolvedRows,
      byRule: audit.summary.byRule, semiLiquid: audit.summary.semiLiquid,
    },
    reconciliation: { perPortfolio: ordered.map(report => ({ portfolioId: report.portfolioId, ...report.reconciliation })) },
    inputs: {
      mappingEffectiveDate: mapping.effectiveDate, mappingFingerprint: fingerprint(mapping),
      cashIdentityFingerprint: fingerprint(cashIdentities),
      sourceFingerprints: ordered.map(report => ({ portfolioId: report.portfolioId, fingerprint: report.sourceFingerprint, bytes: report.sourceBytes, reportParameters: report.reportParameters })),
      pendingRedemptionFingerprint: pending.evidence ? fingerprint(pending.evidence) : null,
      pendingRedemptionBasis: pending.evidence ? 'explicit dated evidence input' : 'no evidence supplied; rows unflagged; evergreen net unavailable',
      cashProxyNormalization: CASH_PROXY_NORMALIZATION,
    },
  };
  snapshot.fingerprint = fingerprint(snapshot);
  return snapshot;
}

/** Structural and arithmetic validation of a snapshot, including its own
 * fingerprint. A fingerprint is drift detection, not source authenticity. */
export function validateFourBucketSnapshot(snapshot, { registry = null } = {}) {
  exactKeys(snapshot, SNAPSHOT_KEYS, 'SNAPSHOT');
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== FOUR_BUCKET_KIND || snapshot.status !== 'fresh') fail('SNAPSHOT_VERSION');
  const { fingerprint: declared, ...body } = snapshot;
  if (fingerprint(body) !== declared) fail('SNAPSHOT_FINGERPRINT');
  exactKeys(snapshot.scope, ['portfolioIds', 'complete', 'basis'], 'SNAPSHOT_SCOPE');
  const ids = snapshot.scope.portfolioIds;
  if (!Array.isArray(ids) || !ids.length || snapshot.scope.complete !== true || ids.some(id => !Number.isSafeInteger(id))
      || ids.join(',') !== [...ids].sort((a, b) => a - b).join(',') || new Set(ids).size !== ids.length) fail('SNAPSHOT_SCOPE');
  if (registry && ids.join(',') !== familyPortfolioIds(registry).join(',')) fail('SNAPSHOT_SCOPE_MISMATCH');
  const started = instantMs(snapshot.readWindow?.startedAt), completed = instantMs(snapshot.readWindow?.completedAt);
  if (started === null || completed === null || started > completed) fail('SNAPSHOT_READ_WINDOW');
  exactKeys(snapshot.reportCutoff, ['earliest', 'latest', 'perPortfolio'], 'SNAPSHOT_CUTOFF');
  const { earliest, latest, perPortfolio } = snapshot.reportCutoff;
  if (!isCalendarDate(earliest) || !isCalendarDate(latest) || earliest > latest || latest > hktDateOfMs(completed)) fail('SNAPSHOT_CUTOFF');
  if (!Array.isArray(perPortfolio) || perPortfolio.map(item => item?.portfolioId).join(',') !== ids.join(',')
      || perPortfolio.some(item => !isCalendarDate(item?.endDate) || item.endDate < earliest || item.endDate > latest)) fail('SNAPSHOT_CUTOFF');
  exactKeys(snapshot.totals, ['totalUsdMicro', 'buckets', 'percent'], 'SNAPSHOT_TOTALS');
  const total = parseMicro(snapshot.totals.totalUsdMicro, 'SNAPSHOT_TOTAL');
  if (total <= 0n) fail('NON_POSITIVE_TOTAL');
  exactKeys(snapshot.totals.buckets, BUCKETS, 'SNAPSHOT_BUCKETS');
  exactKeys(snapshot.totals.percent, BUCKETS, 'SNAPSHOT_PERCENT');
  let sum = 0n;
  for (const bucket of BUCKETS) {
    exactKeys(snapshot.totals.buckets[bucket], ['usdMicro', 'rows'], 'SNAPSHOT_BUCKET');
    const micro = parseMicro(snapshot.totals.buckets[bucket].usdMicro, 'SNAPSHOT_BUCKET');
    if (!Number.isSafeInteger(snapshot.totals.buckets[bucket].rows) || snapshot.totals.buckets[bucket].rows < 0) fail('SNAPSHOT_BUCKET_ROWS');
    if (snapshot.totals.percent[bucket] !== percentOf(micro, total)) fail('SNAPSHOT_PERCENT');
    sum += micro;
  }
  if (sum !== total) fail('SNAPSHOT_TOTAL');
  exactKeys(snapshot.threeLayer, Object.keys(THREE_LAYERS), 'SNAPSHOT_LAYERS');
  for (const [layer, buckets] of Object.entries(THREE_LAYERS)) {
    const expected = buckets.reduce((acc, bucket) => acc + parseMicro(snapshot.totals.buckets[bucket].usdMicro, 'SNAPSHOT_BUCKET'), 0n);
    if (snapshot.threeLayer[layer]?.usdMicro !== String(expected) || snapshot.threeLayer[layer]?.percent !== percentOf(expected, total)) fail('SNAPSHOT_LAYERS');
  }
  const net = snapshot.evergreenNet;
  if (net?.status === 'unavailable') exactKeys(net, ['status', 'reason'], 'SNAPSHOT_EVERGREEN_NET');
  else if (net?.status === 'available') {
    exactKeys(net, ['status', 'evidenceDate', 'evidenceRef', 'pendingUsdMicro', 'netUsdMicro', 'coverageDisplayOnly', 'highlyLiquidUnchanged'], 'SNAPSHOT_EVERGREEN_NET');
    const pendingMicro = parseMicro(net.pendingUsdMicro, 'SNAPSHOT_EVERGREEN_NET');
    if (!isCalendarDate(net.evidenceDate) || net.coverageDisplayOnly !== true || net.highlyLiquidUnchanged !== true || pendingMicro < 0n
        || net.netUsdMicro !== String(parseMicro(snapshot.totals.buckets.evergreen.usdMicro, 'SNAPSHOT_BUCKET') - pendingMicro)) fail('SNAPSHOT_EVERGREEN_NET');
  } else fail('SNAPSHOT_EVERGREEN_NET');
  if (snapshot.coverage?.unresolvedRows !== 0 || !Number.isSafeInteger(snapshot.coverage?.totalRows) || snapshot.coverage.totalRows < 1
      || snapshot.coverage.classifiedRows !== snapshot.coverage.totalRows) fail('SNAPSHOT_COVERAGE');
  const reconciliation = snapshot.reconciliation?.perPortfolio;
  if (!Array.isArray(reconciliation) || reconciliation.map(item => item?.portfolioId).join(',') !== ids.join(',')
      || reconciliation.some(item => item?.withinTolerance !== true)) fail('SNAPSHOT_RECONCILIATION');
  if (!isObject(snapshot.underlyingNav) || !isObject(snapshot.inputs)) fail('SNAPSHOT_INPUTS');
  return snapshot;
}

/** A newer snapshot must be read later and must never move the report cutoff
 * backwards. Reuse of a previous snapshot never rewrites its dates. */
export function assertFourBucketAdvances(previous, next) {
  if (previous == null) return next;
  if (instantMs(next.readWindow.completedAt) <= instantMs(previous.readWindow.completedAt)) fail('READ_WINDOW_NOT_ADVANCED');
  if (next.reportCutoff.latest < previous.reportCutoff.latest) fail('CUTOFF_REGRESSED');
  return next;
}

/** Ordinary per-report resolution with a validated last-good fallback. The
 * fresh computation runs first; on any failure the previous snapshot is
 * reused only if it validates, explicitly dated, never re-dated, never zero. */
export function resolveFourBucket({ compute, previous = null, now = Date.now(), registry = null } = {}) {
  if (typeof compute !== 'function') fail('INVALID_COMPUTE');
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  const fallback = reason => {
    if (previous == null) return { status: 'unavailable', reason };
    try { validateFourBucketSnapshot(previous, { registry }); }
    catch (error) { return { status: 'unavailable', reason, previousReason: error.fourBucketCode ?? 'INVALID_PREVIOUS' }; }
    const ageDays = Math.floor((nowMs - instantMs(previous.readWindow.completedAt)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < 0) return { status: 'unavailable', reason, previousReason: 'PREVIOUS_IN_FUTURE' };
    return { status: 'fallback', reason, snapshot: previous, ageDays, reportCutoff: previous.reportCutoff };
  };
  let snapshot;
  try { snapshot = validateFourBucketSnapshot(compute(), { registry }); }
  catch (error) { return fallback(error.fourBucketCode ?? 'AGGREGATION_FAILED'); }
  try { assertFourBucketAdvances(previous, snapshot); }
  catch (error) { return fallback(error.fourBucketCode); }
  return { status: 'fresh', snapshot, previousStatus: previous == null ? 'none' : 'superseded' };
}

/** Inert transport for a verified report page. Parsing is strict and the
 * template must be unique; a records-update must preserve it byte for byte. */
export function renderFourBucketTemplate(snapshot, { registry = null } = {}) {
  validateFourBucketSnapshot(snapshot, { registry });
  const json = canonicalJson(snapshot);
  if (Buffer.byteLength(json) > MAX_TEMPLATE_BYTES || /<\/?(?:template|script)/i.test(json)) fail('TEMPLATE_SIZE_OR_CONTENT');
  return `<template id="${FOUR_BUCKET_TEMPLATE_ID}" type="application/json">${json}</template>`;
}
export function parseFourBucketTemplate(html, { registry = null } = {}) {
  const matches = [...String(html ?? '').matchAll(new RegExp(`<template id="${FOUR_BUCKET_TEMPLATE_ID}" type="application/json">([^<]*)</template>`, 'g'))];
  if (matches.length !== 1) fail('TEMPLATE_NOT_UNIQUE', matches.length);
  const raw = matches[0][1];
  if (Buffer.byteLength(raw) > MAX_TEMPLATE_BYTES) fail('TEMPLATE_SIZE_OR_CONTENT');
  // Strict parse first (duplicate keys, depth, escapes), then plain objects.
  try { parseDecisionJson(raw, MAX_TEMPLATE_BYTES); } catch (error) { fail('TEMPLATE_JSON_INVALID', error.message); }
  const parsed = JSON.parse(raw);
  if (canonicalJson(parsed) !== raw) fail('TEMPLATE_NOT_CANONICAL');
  return validateFourBucketSnapshot(parsed, { registry });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file, maxBytes = 8 * 1024 * 1024) => {
  if (fs.statSync(file).size > maxBytes) fail('INPUT_TOO_LARGE', file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
/** Trusted repository inputs. Never substitute caller-supplied copies in production. */
export function loadTrustedInputs(root = repoRoot) {
  return {
    registry: readJson(path.join(root, 'claude/xuan-ib-portfolio-registry.json')),
    mapping: readJson(path.join(root, 'claude/four-bucket-mapping.json')),
    cashIdentities: readJson(path.join(root, 'claude/xuan-ib-cash-identities-v1.json')),
  };
}

/** Convenience for the per-report path: normalize every family read, then
 * resolve with the previous published snapshot as the last-good fallback.
 * Each read is `{portfolioId, raw, readStartedAt, readCompletedAt, listing}`
 * where `listing` is either the listing evidence object or
 * `{raw, readCompletedAt}` built from a captured holdings response. */
export function deriveFourBucket({ reads, previous = null, pendingRedemption = null, now = Date.now(), trusted = loadTrustedInputs() } = {}) {
  const { registry, mapping, cashIdentities } = trusted;
  const listingOf = read => (isObject(read.listing) && Object.hasOwn(read.listing, 'raw')
    ? listingFromHoldingsResponse(read.listing.raw, { portfolioId: read.portfolioId, readCompletedAt: read.listing.readCompletedAt })
    : read.listing);
  return resolveFourBucket({
    previous, now, registry,
    compute: () => aggregateFourBucket({
      registry, mapping, cashIdentities, pendingRedemption, now,
      reports: (Array.isArray(reads) ? reads : fail('INVALID_READS')).map(read => normalizeSharesightReport(read.raw, {
        registry, portfolioId: read.portfolioId, readStartedAt: read.readStartedAt, readCompletedAt: read.readCompletedAt, listing: listingOf(read),
      })),
    }),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Private local use only. Prints status, dates and counts; never amounts.
  try {
    const args = process.argv.slice(2);
    const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    if (args[0] !== 'aggregate' || !option('--input') || !option('--output')) {
      throw new Error('usage: xuan-ib-four-bucket.mjs aggregate --input READS.json --output SNAPSHOT.json [--previous PREVIOUS.json]');
    }
    const input = readJson(option('--input'));
    const result = deriveFourBucket({
      reads: input.reads, pendingRedemption: input.pendingRedemption ?? null,
      previous: option('--previous') ? readJson(option('--previous')) : null,
    });
    fs.writeFileSync(option('--output'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const snapshot = result.snapshot ?? null;
    process.stdout.write(`${JSON.stringify({
      status: result.status, reason: result.reason ?? null, ageDays: result.ageDays ?? null,
      fingerprint: snapshot?.fingerprint ?? null, reportCutoff: snapshot ? { earliest: snapshot.reportCutoff.earliest, latest: snapshot.reportCutoff.latest } : null,
      readWindow: snapshot?.readWindow ?? null,
      coverage: snapshot ? { totalRows: snapshot.coverage.totalRows, unresolvedRows: snapshot.coverage.unresolvedRows, listingOnlyIdentities: snapshot.coverage.listingOnlyIdentities } : null,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.fourBucketCode ?? error.message}\n`);
    process.exitCode = 1;
  }
}
