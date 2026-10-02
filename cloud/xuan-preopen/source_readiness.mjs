// Upstream coverage is distinct from local HTTP capture time. This proposed
// evidence contract is deliberately fail-closed until actual IB payloads can
// be mapped and independently verified; transport must never invent fields.
export const IB_READINESS_KEYS = Object.freeze(['ib.accountSummary','ib.positions','ib.orders','ib.trades']);
export function assessIbReadiness(sources, {sourceDate, now = Date.now()} = {}) {
  const issues = [], evidence = [];
  for (const sourceKey of IB_READINESS_KEYS) {
    const matches = sources.filter(s => s.sourceKey === sourceKey);
    if (matches.length !== 1) {issues.push(`${sourceKey}:MISSING_OR_DUPLICATE`); continue;}
    const coverage = matches[0].raw?.coverage;
    // No fallback to startedAt/completedAt, order timestamps or latest trade.
    if (coverage?.origin !== 'IBKR' || coverage.schemaVersion !== 1 || coverage.complete !== true
        || coverage.paginationComplete !== true || coverage.targetTradeDate !== sourceDate
        || coverage.coveredThroughDate < sourceDate || !/^\d{4}-\d{2}-\d{2}$/.test(coverage.coveredThroughDate || '')
        || typeof coverage.snapshotId !== 'string' || !coverage.snapshotId) {
      issues.push(`${sourceKey}:UPSTREAM_COVERAGE_UNVERIFIED`); continue;
    }
    const asOf = Date.parse(coverage.asOf);
    if (!Number.isFinite(asOf) || asOf > now || now - asOf > 30 * 60_000) {
      issues.push(`${sourceKey}:UPSTREAM_ASOF_STALE`); continue;
    }
    evidence.push({sourceKey, asOf: coverage.asOf, snapshotId: coverage.snapshotId,
      targetTradeDate: sourceDate, coveredThroughDate: coverage.coveredThroughDate});
  }
  if (new Set(evidence.map(e => e.snapshotId)).size > 1) issues.push('IB_SNAPSHOT_CONFLICT');
  return {status: issues.length ? 'data-not-ready' : 'ready', targetTradeDate: sourceDate, issues, evidence};
}

export function validateReadinessReceipt(readiness, sources, {sourceDate, now = Date.now()} = {}) {
  if (readiness?.status !== 'ready' || readiness.targetTradeDate !== sourceDate
      || !Array.isArray(readiness.issues) || readiness.issues.length
      || !Array.isArray(readiness.evidence) || readiness.evidence.length !== IB_READINESS_KEYS.length) return false;
  const simulated = readiness.evidence.map(e => ({sourceKey: e.sourceKey, raw: {coverage: {
    ...e, schemaVersion: 1, origin: 'IBKR', complete: true, paginationComplete: true,
  }}}));
  return IB_READINESS_KEYS.every(key => sources.filter(s => s.sourceKey === key && /^[a-f0-9]{64}$/.test(s.sha256 || '')).length === 1)
    && assessIbReadiness(simulated, {sourceDate, now}).status === 'ready';
}
