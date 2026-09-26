// IB-only weekly input adapter. Pure/private; no fetching, trades or publication.
import {simulateEtfTrend, TREND_METHOD, ETF_WEIGHTS} from './xuan-ib-etf-trend.mjs';
export const METHOD = 'xuan-weekly-ib-only-v1';
export const PERIOD_START = '2026-08-01';
export const BASELINE = '2026-07-31';
const check = (v, m) => { if (!v) throw new Error(m); };
const dateOK = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const next = s => new Date(Date.parse(s) + 86400000).toISOString().slice(0, 10);
const finite = Number.isFinite;

export function buildWeeklyAbc({nav, flows, coverage, quotes, cutoff}) {
  check(dateOK(cutoff) && cutoff >= PERIOD_START, 'Invalid cutoff');
  check(coverage?.source === 'ib-flex' && coverage.currency === 'USD'
    && dateOK(coverage.from) && coverage.from <= BASELINE && coverage.to >= cutoff
    && coverage.verified === true && typeof coverage.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(coverage.sha256), 'IB source coverage not verified');
  check(Array.isArray(nav) && Array.isArray(flows) && quotes && typeof quotes === 'object', 'Invalid source arrays');
  const navMap = new Map();
  for (const row of nav) {
    check(dateOK(row.date) && finite(row.usd) && row.usd > 0, 'Invalid NAV');
    check(!navMap.has(row.date) || navMap.get(row.date) === row.usd, 'Conflicting NAV date');
    navMap.set(row.date, row.usd);
  }
  check(navMap.has(BASELINE), 'Missing July 31 opening NAV');
  const flowMap = new Map(), ids = new Map();
  for (const f of flows) {
    check(dateOK(f.date) && typeof f.id === 'string' && f.id.length > 0 && finite(f.usd)
      && f.kind === 'external', 'Unverified external flow');
    const signature = JSON.stringify([f.date, f.usd, f.kind]);
    check(!ids.has(f.id) || ids.get(f.id) === signature, 'Conflicting flow ID');
    if (ids.has(f.id)) continue;
    ids.set(f.id, signature);
    if (f.date > BASELINE && f.date <= cutoff) flowMap.set(f.date, [...(flowMap.get(f.date) || []), {...f}]);
  }
  const days = [];
  let previousNav = null;
  for (let date = BASELINE; date <= cutoff; date = next(date)) {
    const dayQuotes = quotes[date];
    check(dayQuotes && Object.keys(ETF_WEIGHTS).every(s => dayQuotes[s]), 'Explicit quote/calendar evidence required');
    const dayFlows = flowMap.get(date) || [];
    let actual = navMap.get(date) ?? null;
    // Only an explicit IB closed-calendar entry permits carrying a prior NAV.
    if (actual === null && coverage.closedDates?.includes(date) && previousNav !== null)
      actual = previousNav + dayFlows.reduce((n, f) => n + f.usd, 0);
    if (actual !== null) previousNav = actual;
    days.push({date, actualUsd: actual, actualComplete: actual !== null,
      flowsComplete: !(coverage.unresolvedDates || []).includes(date), flows: dayFlows,
      quotes: dayQuotes, sourceRef: `ib-flex:${coverage.sha256}`});
  }
  const result = simulateEtfTrend({methodId:TREND_METHOD, startDate:BASELINE,
    frozenDate:'2026-09-26', initialUsd:navMap.get(BASELINE), reserveUsd:0, days});
  // Do not feed the legacy date-selected method renderer. This envelope is private.
  return {schemaVersion:1, methodId:METHOD, periodStart:PERIOD_START, baselineDate:BASELINE,
    scope:'IB-HK', includesNoah:false, pendingCallDeduction:0,
    weights:{B:ETF_WEIGHTS,C:{CSPX:1}}, result};
}
