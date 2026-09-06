// Pure shared schedule: safe to import in browsers and Node. No network, DOM,
// credentials or financial data. Holidays still receive a short closed-market
// report; this module determines delivery slots, not whether markets are open.
export const PM_RUN_TARGET_MS = 20 * 60 * 1000;
export const PM_SCHEDULE_CUTOVER_HKT_DATE = "2026-09-04";
export const PM_OPENING_CUTOVER_HKT_DATE = "2026-09-06";
export const AM_WATCH_CRON = "35 0 * * 2-6";
export const PM_WATCH_CRONS = Object.freeze(["55 13 * * 1-5", "55 14 * * 1-5"]);
export const LEGACY_PM_WATCH_CRONS = Object.freeze(["50 13 * * 1-5", "50 14 * * 1-5"]);

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;
const EDITIONS = ["am", "pm"];
const newYorkClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

const dateEpoch = date => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid report date");
  const epoch = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) throw new Error("invalid report date");
  return epoch;
};
const instant = now => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid schedule instant");
  return now.getTime();
};
const checkEdition = edition => {
  if (!EDITIONS.includes(edition)) throw new Error(`unsupported edition: ${edition}`);
};
const newYorkWallEpoch = epoch => {
  const parts = Object.fromEntries(newYorkClock.formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
};

export function hktContext(now = new Date()) {
  const shifted = new Date(instant(now) + HKT_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

const newYorkStartEpoch = (dataDate, minute = dataDate < PM_OPENING_CUTOVER_HKT_DATE ? 35 : 30) => {
  const midnight = dateEpoch(dataDate);
  const desiredWall = midnight + (9 * 60 + minute) * 60 * 1000;
  let epoch = desiredWall;
  // Resolve the named timezone, never infer DST from a month or fixed offset.
  for (let n = 0; n < 3; n += 1) epoch += desiredWall - newYorkWallEpoch(epoch);
  if (!Number.isFinite(epoch) || newYorkWallEpoch(epoch) !== desiredWall) throw new Error("New York report slot is unresolved");
  return epoch / 1000;
};

export function slotStartEpoch(dataDate, edition) {
  const midnight = dateEpoch(dataDate);
  checkEdition(edition);
  if (edition === "am") return midnight / 1000; // 08:00 HKT = 00:00 UTC.
  // Historical PM evidence keeps the contract that actually applied that day.
  if (dataDate < PM_SCHEDULE_CUTOVER_HKT_DATE) return midnight / 1000 + 12 * 3600 + 55 * 60;
  return newYorkStartEpoch(dataDate);
}

export function slotDueEpoch(dataDate, edition) {
  const start = slotStartEpoch(dataDate, edition);
  const budget = edition === "am" ? 35 * 60
    : dataDate < PM_SCHEDULE_CUTOVER_HKT_DATE ? 30 * 60
    : dataDate < PM_OPENING_CUTOVER_HKT_DATE ? 10 * 60
    : PM_RUN_TARGET_MS / 1000;
  return start + budget;
}

export function expectedEditionAt(now = new Date(), editionFilter = null) {
  if (editionFilter !== null) checkEdition(editionFilter);
  const context = hktContext(now), nowEpoch = instant(now) / 1000;
  let latest = null;
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(dateEpoch(context.date) - offset * 86400000);
    const date = day.toISOString().slice(0, 10), weekday = day.getUTCDay();
    for (const edition of EDITIONS) {
      if (editionFilter !== null && edition !== editionFilter) continue;
      if (edition === "am" ? weekday < 2 || weekday > 6 : weekday < 1 || weekday > 5) continue;
      const dueEpoch = slotDueEpoch(date, edition);
      if (dueEpoch <= nowEpoch && (!latest || dueEpoch > latest.dueEpoch)) latest = {date, edition, dueEpoch};
    }
  }
  if (!latest) return {...context, expectedEdition: null, reason: "no-due-slot"};
  return {...context, expectedEdition: latest.edition, expectedDate: latest.date,
    startEpoch: slotStartEpoch(latest.date, latest.edition), dueEpoch: latest.dueEpoch, reason: "latest-due-slot"};
}

// GitHub cron uses UTC. Two seasonal candidates avoid a manual clock change;
// only the candidate matching 09:55 New York is enabled. A delayed job is still
// audited, not silently skipped for missing an exact wall-clock minute.
export function scheduledWatchEnabled(expression, now = new Date()) {
  const context = hktContext(now);
  if (!expression || expression === AM_WATCH_CRON) return true;
  if (![...PM_WATCH_CRONS, ...LEGACY_PM_WATCH_CRONS].includes(expression)) throw new Error("unrecognized watcher schedule");
  const minute = context.date < PM_OPENING_CUTOVER_HKT_DATE ? 50 : 55;
  const watch = new Date(newYorkStartEpoch(context.date, minute) * 1000);
  return expression === `${minute} ${watch.getUTCHours()} * * 1-5`;
}

export function scheduledWatchEdition(expression) {
  if (!expression) return null;
  if (expression === AM_WATCH_CRON) return "am";
  if ([...PM_WATCH_CRONS, ...LEGACY_PM_WATCH_CRONS].includes(expression)) return "pm";
  throw new Error("unrecognized watcher schedule");
}
