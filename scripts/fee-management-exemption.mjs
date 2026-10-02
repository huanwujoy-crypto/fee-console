// Private, owner-authorized gift lots. Never match a ticker globally.
import { isCalendarDate } from './fee-engine.mjs';

const fail = () => { throw new Error('MANAGEMENT_EXEMPTION_INVALID'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const positiveId = n => Number.isSafeInteger(n) && n > 0;
export const RULE_KEYS = ['id', 'account', 'portfolioId', 'holdingId', 'ticker', 'firstHeldOn',
  'effectiveFrom', 'authorizationRef', 'giftTradeIds'];

export function validateManagementRegistry(registry) {
  if (registry === undefined) return undefined;
  if (!exact(registry, ['schemaVersion', 'entries']) || registry.schemaVersion !== 1
      || !Array.isArray(registry.entries) || !registry.entries.length || registry.entries.length > 100) fail();
  const ids = new Set(), holdings = new Set();
  for (const r of registry.entries) {
    if (!exact(r, RULE_KEYS) || !/^[a-z0-9-]{1,64}$/.test(r.id) || ids.has(r.id)
        || r.account !== 'webull' || r.portfolioId !== 1350094 || !positiveId(r.holdingId)
        || !/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(r.ticker)
        || !isCalendarDate(r.firstHeldOn) || !isCalendarDate(r.effectiveFrom)
        || r.effectiveFrom < r.firstHeldOn || typeof r.authorizationRef !== 'string'
        || !r.authorizationRef.trim() || r.authorizationRef.length > 1000
        || !Array.isArray(r.giftTradeIds) || !r.giftTradeIds.length
        || !r.giftTradeIds.every(positiveId) || new Set(r.giftTradeIds).size !== r.giftTradeIds.length
        || holdings.has(r.holdingId)) fail();
    ids.add(r.id); holdings.add(r.holdingId);
  }
  return { schemaVersion: 1, entries: registry.entries.map(r => ({ ...r,
    giftTradeIds: [...r.giftTradeIds].sort((a,b) => a-b) })).sort((a,b) => a.id.localeCompare(b.id)) };
}

/** Full confirmed history must reconcile to the exact target holding quantity.
 * Unknown BUY lots are chargeable; SELL consumes exempt shares first, a
 * conservative policy that never silently exempts paid shares in mixed lots.
 * Splits/corporate actions/unconfirmed rows fail closed pending evidence.
 */
export function resolveManagementExemptions({ registry, proposals = [], input, date, accounts }) {
  if (!isCalendarDate(date)) fail();
  const saved = validateManagementRegistry(registry);
  if (!Array.isArray(proposals)) fail();
  const entries = saved?.entries || [];
  for (const proposal of proposals) {
    validateManagementRegistry({ schemaVersion: 1, entries: [proposal] });
    const old = entries.find(r => r.id === proposal.id || r.holdingId === proposal.holdingId);
    if (old) {
      if (JSON.stringify(validateManagementRegistry({schemaVersion:1,entries:[old]}))
          !== JSON.stringify(validateManagementRegistry({schemaVersion:1,entries:[proposal]}))) fail();
    } else entries.push(proposal);
  }
  const next = entries.length ? validateManagementRegistry({schemaVersion:1,entries}) : undefined;
  if (!next) return { registry: undefined, rows: undefined };
  if (!exact(input, ['schemaVersion','date','holdings','trades','historyComplete'])
      || input.schemaVersion !== 1 || input.date !== date || input.historyComplete !== true
      || !Array.isArray(input.holdings) || !Array.isArray(input.trades)) fail();
  const rows = [];
  for (const r of next.entries) {
    if (date < r.effectiveFrom) continue;
    const matches = input.holdings.filter(h => h.portfolioId === r.portfolioId && h.holdingId === r.holdingId);
    if (matches.length > 1) fail();
    const h = matches[0];
    if (h && (h.account !== r.account || h.ticker !== r.ticker || h.sourceDate !== date
        || !Number.isFinite(h.quantity) || h.quantity < 0 || !Number.isFinite(h.valueUsd) || h.valueUsd < 0)) fail();
    const trades = input.trades.filter(t => t.portfolioId === r.portfolioId && t.holdingId === r.holdingId)
      .sort((a,b) => a.date.localeCompare(b.date) || a.id-b.id);
    if (!trades.length || trades[0].date !== r.firstHeldOn) fail();
    let quantity = 0, gift = 0;
    const seen = new Set(), approvedSeen = new Set();
    for (const t of trades) {
      if (!positiveId(t.id) || seen.has(t.id) || !isCalendarDate(t.date) || t.date > date
          || t.confirmed !== true || !Number.isFinite(t.quantity) || t.quantity <= 0
          || !['OPENING_BALANCE','BUY','SELL'].includes(t.type)) fail();
      seen.add(t.id);
      const approved = r.giftTradeIds.includes(t.id);
      if (t.type === 'SELL') {
        if (approved || t.quantity > quantity + 1e-8) fail();
        quantity -= t.quantity; gift = Math.max(0, gift-t.quantity);
      } else {
        quantity += t.quantity;
        if (approved) {
          if (t.giftEvidence !== true || t.zeroPrice !== true) fail();
          approvedSeen.add(t.id); gift += t.quantity;
        } else if (t.type === 'BUY' && t.date >= r.effectiveFrom && t.date.endsWith('-01')
            && t.monthlyGiftEvidence === true && t.zeroPrice === true) {
          // Owner's monthly-gift instruction applies only to the same enrolled
          // identity and the strict source-reader promotional award proof.
          gift += t.quantity;
        }
      }
    }
    if (approvedSeen.size !== r.giftTradeIds.length || Math.abs(quantity-(h?.quantity || 0)) > 1e-8
        || gift > quantity + 1e-8) fail();
    const valueUsd = quantity > 0 ? Math.round((h.valueUsd * gift / quantity)*100)/100 : 0;
    rows.push({ id:r.id, account:r.account, valueUsd });
  }
  validateManagementPoint({d:date,...accounts,managementExemptions:rows}, next);
  return {registry:next, rows};
}

// Same commitment and bounds are applied to the writer, receipt, and UI.
export function validateManagementPoint(point, registry) {
  const active = registry?.entries.filter(r => r.effectiveFrom <= point.d) || [];
  const rows = point.managementExemptions;
  if (rows === undefined) { if (active.length) fail(); return undefined; }
  if (!registry || !Array.isArray(rows) || rows.length !== active.length) fail();
  const seen = new Set(), totals = {};
  for (const row of rows) {
    const rule = active.find(r => r.id === row?.id);
    if (!exact(row,['id','account','valueUsd']) || !rule || row.account !== rule.account || seen.has(row.id)
        || !Number.isFinite(row.valueUsd) || row.valueUsd < 0) fail();
    seen.add(row.id); totals[row.account] = (totals[row.account] || 0) + row.valueUsd;
  }
  for (const [account,value] of Object.entries(totals)) if (!Number.isFinite(point[account]) || value > point[account]) fail();
  return rows.map(r => ({...r})).sort((a,b) => a.id.localeCompare(b.id));
}
