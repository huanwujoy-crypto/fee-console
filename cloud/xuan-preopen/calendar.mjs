// Reviewed exchange calendars, not a weekday-only market-open assumption.
// Official annual tables checked 2026-10-01; unsupported years fail closed.
const holidays = {
  NYSE: {
    2026: ['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
    2027: ['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'],
    2028: ['01-17','02-21','04-14','05-29','06-19','07-04','09-04','11-23','12-25'],
  },
  XETRA: {
    2026: ['01-01','04-03','04-06','05-01','12-24','12-25','12-26','12-31'],
    2027: ['01-01','03-26','03-29','05-01','12-24','12-25','12-26','12-31'],
    2028: ['01-01','04-14','04-17','05-01','12-24','12-25','12-26','12-31'],
  },
  // Independently checked Nasdaq table; future years are not inferred from NYSE.
  NASDAQ: {
    2026: ['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
  },
  LSE: {
    // LSE recognises England/Wales bank holidays; 24 and 31 Dec are open half days.
    2026: ['01-01','04-03','04-06','05-04','05-25','08-31','12-25','12-28'],
  },
  EURONEXT: {
    // Group means ANY of Amsterdam, Brussels, Dublin, Lisbon, Milan, Oslo,
    // Paris is open. The official seven-column table closes ALL on these days.
    // Individual-venue holidays never imply the entire group is closed.
    2026: ['01-01','04-03','04-06','05-01','12-25'],
  },
};
export const calendarSources = Object.freeze([
  'https://www.nyse.com/trade/hours-calendars',
  'https://cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours',
  'https://www.nasdaqtrader.com/trader.aspx?id=Calendar',
  'https://www.londonstockexchange.com/equities-trading/business-days',
  'https://www.gov.uk/bank-holidays',
  'https://www.euronext.com/en/trading/trading-hours-holidays',
]);
export function hktDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(now));
}
export function marketOpen(date, market) {
  const value = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(value.getTime()) || value.toISOString().slice(0,10) !== date
      || !holidays[market]?.[date.slice(0,4)]) throw new Error('OFFICIAL_CALENDAR_UNAVAILABLE');
  return ![0,6].includes(value.getUTCDay()) && !holidays[market][date.slice(0,4)].includes(date.slice(5));
}
export function planPreopen(now = Date.now()) {
  const dataDate = hktDate(now);
  const openMarkets = ['NYSE','NASDAQ','XETRA','LSE','EURONEXT'].filter(market => marketOpen(dataDate, market));
  if (!openMarkets.length) return {status: 'no-action', dataDate, reason: 'ALL_REVIEWED_MARKETS_CLOSED', calendarSources};
  // At 13:00 HKT all prior US regular sessions have closed. Never request
  // today's uncompleted valuation or mistake a missing response for a holiday.
  let previous = Date.parse(`${dataDate}T00:00:00Z`) - 86_400_000;
  for (let count = 0; count < 10; count++, previous -= 86_400_000) {
    const sourceDate = new Date(previous).toISOString().slice(0,10);
    if (marketOpen(sourceDate, 'NYSE')) return {status: 'generate', dataDate, sourceDate, openMarkets, calendarSources};
  }
  throw new Error('COMPLETED_SESSION_UNAVAILABLE');
}
