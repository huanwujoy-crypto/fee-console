// MCP DAYS_7 boundaries are UTC. Selecting the target NY session does not
// establish final ledger coverage, zero executions, or execution-ID uniqueness.
export function selectNewYorkSession(trades, targetDate) {
  if (!Array.isArray(trades) || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('IB_TRADE_SESSION_INPUT_INVALID');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' });
  const selected = [];
  for (const trade of trades) {
    // Reject timezone-free values rather than assuming the local or UTC zone.
    if (typeof trade?.trade_time !== 'string'
      || !/(Z|[+-]\d{2}:\d{2})$/.test(trade.trade_time)
      || !Number.isFinite(Date.parse(trade.trade_time)))
      throw new Error('IB_TRADE_TIME_ZONE_UNVERIFIED');
    const parts = Object.fromEntries(format.formatToParts(new Date(trade.trade_time))
      .filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === targetDate) selected.push(trade);
  }
  return { targetDate, selected, coverageVerified: false, executionUniquenessVerified: false };
}
